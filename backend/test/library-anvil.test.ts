import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, ContractFactory, Interface, JsonRpcProvider, keccak256, type InterfaceAbi } from "ethers";
import type { TestContext } from "node:test";
import { test } from "node:test";
import libraryFixture from "../../docs/fixtures/library-v1.json" with { type: "json" };
import { LibraryRepository } from "../src/modules/library/library.repository.ts";
import { LibraryService } from "../src/modules/library/library.service.ts";
import type { LibraryDemoSeed } from "../src/modules/library/library.types.ts";

const rpcUrl = process.env.LIBRARY_ANVIL_URL;
const depositWei = libraryFixture.policy.depositWei;
const replacementPriceWei = "30000000000000000000";
const bookId = `0x${"ab".repeat(32)}`;

type Artifact = { abi: unknown[]; bytecode: { object: string } };

test("Library reconciles a real Anvil deposit receipt after database restart", {
  skip: !rpcUrl ? "Set LIBRARY_ANVIL_URL to run the disposable local-chain acceptance test" : false,
}, async (t: TestContext) => {
  const testDir = mkdtempSync(join(tmpdir(), "library-anvil-"));
  const databasePath = join(testDir, "library.sqlite");
  const artifactPath = join(dirname(fileURLToPath(import.meta.url)), "../../contracts/out/LibraryDepositEscrow.sol/LibraryDepositEscrow.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Artifact;
  const provider = new JsonRpcProvider(rpcUrl, 20261, { staticNetwork: true, batchMaxCount: 100 });
  let repository: LibraryRepository | undefined;
  let service: LibraryService | undefined;
  t.after(() => {
    service?.close();
    repository?.close();
    provider.destroy();
    rmSync(testDir, { recursive: true, force: true });
  });

  assert.equal((await provider.getNetwork()).chainId, 20261n);
  const administrator = await provider.getSigner(0);
  const librarian = await provider.getSigner(1);
  const treasury = await provider.getSigner(2);
  const student = await provider.getSigner(3);
  const administratorAddress = await administrator.getAddress();
  const librarianAddress = await librarian.getAddress();
  const treasuryAddress = await treasury.getAddress();
  const studentAddress = await student.getAddress();

  const bytecode = artifact.bytecode.object.startsWith("0x") ? artifact.bytecode.object : `0x${artifact.bytecode.object}`;
  const factory = new ContractFactory(artifact.abi as never[], bytecode, administrator);
  const escrow = await factory.deploy(administratorAddress, librarianAddress, treasuryAddress);
  const deploymentReceipt = await escrow.deploymentTransaction()?.wait();
  assert.ok(deploymentReceipt && deploymentReceipt.status === 1);
  const escrowAddress = await escrow.getAddress();
  const escrowContract = new Contract(escrowAddress, artifact.abi as InterfaceAbi, administrator);
  const iface = new Interface(libraryFixture.abi);
  const bookKey = bookId as `0x${string}`;
  const seedTx = await escrowContract.getFunction("seedBookTerms")(bookKey, depositWei, replacementPriceWei);
  const seedReceipt = await seedTx.wait();
  assert.ok(seedReceipt && seedReceipt.status === 1);
  const sealTx = await escrowContract.getFunction("sealBookTerms")(bookKey);
  const sealReceipt = await sealTx.wait();
  assert.ok(sealReceipt && sealReceipt.status === 1);
  const latest = await provider.getBlock("latest");
  assert.ok(latest);
  const runtimeCodeHash = keccak256(await provider.getCode(escrowAddress));

  const deployment = {
    schemaVersion: 1,
    status: "deployed",
    chainId: 20261,
    abiVersion: 1,
    environment: "local-anvil",
    library: {
      schemaVersion: 1,
      status: "deployed",
      chainId: 20261,
      abiVersion: 1,
      environment: "local-anvil",
      verifiedAt: { blockNumber: latest.number, blockHash: latest.hash! },
      escrow: {
        address: escrowAddress,
        abiVersion: 1,
        abi: libraryFixture.abi,
        transactionHash: deploymentReceipt.hash,
        blockNumber: deploymentReceipt.blockNumber,
        blockHash: deploymentReceipt.blockHash,
        runtimeCodeHash,
      },
      roles: { deployer: administratorAddress, administrator: administratorAddress, librarian: librarianAddress },
      treasury: treasuryAddress,
      policy: libraryFixture.policy,
      books: [{ bookId, depositWei, replacementPriceWei, sealed: true }],
      seedTransactions: [
        { type: "seedBookTerms", bookId, transactionHash: seedReceipt.hash,
          blockNumber: seedReceipt.blockNumber, blockHash: seedReceipt.blockHash },
        { type: "sealBookTerms", bookId, transactionHash: sealReceipt.hash,
          blockNumber: sealReceipt.blockNumber, blockHash: sealReceipt.blockHash },
      ],
    },
  };
  const seed: LibraryDemoSeed = {
    version: 1,
    books: [{ bookId, title: "Local EVM acceptance fixture", author: "Test Fixture", isbn: null,
      depositWei, replacementPriceWei, copies: [{ copyId: "copy-001", barcode: "LC-001" }] }],
    accounts: [{ wallet: studentAddress, role: "STUDENT" }, { wallet: librarianAddress, role: "LIBRARIAN" }],
  };
  const freshness = { maxStaleSeconds: 300, maxFutureDriftSeconds: 30, minConfirmations: 1 };
  const studentAccount = { wallet: studentAddress as `0x${string}`, role: "STUDENT" as const };

  repository = new LibraryRepository(databasePath);
  repository.seedDemo(seed);
  service = new LibraryService(repository, { deployment, allowLocal: true, rpcUrl,
    chainFreshness: freshness, now: () => Math.floor(Date.now() / 1000) });

  const [book] = await service.listBooks(studentAddress);
  assert.equal(book.bookId, bookId);
  assert.equal(book.replacementPriceWei, replacementPriceWei);
  const { request, depositIntent } = await service.createRequest({ account: studentAccount,
    bookId, idempotencyKey: "anvil-restart-acceptance" });
  assert.ok(depositIntent);
  const depositTx = await student.sendTransaction({ to: escrowAddress, data: depositIntent.data,
    value: BigInt(depositIntent.valueWei) });
  const depositReceipt = await depositTx.wait();
  assert.ok(depositReceipt && depositReceipt.status === 1);
  const submitted = await service.submitTransaction(studentAccount, request.requestId,
    { action: "deposit", txHash: depositTx.hash });
  assert.equal(submitted.request.status, "PENDING_APPROVAL");
  assert.equal(submitted.transaction?.status, "CONFIRMED");

  service.close();
  service = undefined;
  repository.close();
  repository = undefined;
  repository = new LibraryRepository(databasePath);
  service = new LibraryService(repository, { deployment, allowLocal: true, rpcUrl,
    chainFreshness: freshness, now: () => Math.floor(Date.now() / 1000) });
  const recovered = await service.getRequest(studentAccount, request.requestId);
  assert.equal(recovered.status, "PENDING_APPROVAL");
  assert.equal(recovered.transactions.find((transaction) => transaction.action === "deposit")?.status, "CONFIRMED");
  assert.equal(iface.getEvent("DepositReceived")?.name, "DepositReceived");
});
