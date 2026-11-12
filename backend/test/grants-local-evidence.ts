// Real transactions on an ephemeral loopback Anvil only; never uses the operator's RPC or keys.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  Contract, ContractFactory, JsonRpcProvider, Wallet, id, keccak256,
  type InterfaceAbi, type TransactionReceipt,
} from "ethers";
import { requireDeployment, type DeployedManifest, type PublicContract } from "@intracampus/network";
import { parseSeedConfig } from "../scripts/seed-demo.ts";
import { createGrantSeedTransport, seedGrant } from "../scripts/seed-grants.ts";
import { createApp } from "../src/app.ts";
import { GrantsReader } from "../src/modules/grants/grants.rpc.ts";
import { GrantSeedJournal } from "../src/modules/grants/grants.seed-repository.ts";
import { GrantsService } from "../src/modules/grants/grants.service.ts";
import type { GrantLookup } from "../src/modules/grants/grants.types.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const contractsDir = join(root, "contracts");
const names = ["StudentSBTIdentity", "CampusPaymentRegistry", "PurposeBoundGrantVault"] as const;
const unit = 10n ** 18n;
const food = id("FOOD");
const parking = id("PARKING");
const exec = promisify(execFile);
let stage = "load-current-artifacts";

type Artifact = { abi: Record<string, unknown>[]; bytecode: { object: string } };
const { loadVerifiedArtifact } = await import(pathToFileURL(join(contractsDir, "script/load-verified-artifact.mjs")).href) as {
  loadVerifiedArtifact: (directory: string, name: string) => Promise<Artifact>;
};

async function freePort(): Promise<number> {
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const endpoint = listener.address();
  assert(endpoint && typeof endpoint !== "string");
  await new Promise<void>((done, fail) => listener.close((error) => error ? fail(error) : done()));
  return endpoint.port;
}

function publicReceipt(receipt: TransactionReceipt) {
  return {
    transactionHash: receipt.hash, status: receipt.status, blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash, from: receipt.from, to: receipt.to,
    gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.gasPrice.toString(),
    logs: receipt.logs.map((log) => ({
      address: log.address, topics: log.topics, data: log.data, logIndex: log.index,
      transactionHash: log.transactionHash, blockNumber: log.blockNumber, blockHash: log.blockHash,
    })),
  };
}

async function main(): Promise<void> {
  const artifacts = Object.fromEntries(await Promise.all(names.map(async (name) =>
    [name, await loadVerifiedArtifact(contractsDir, name)]))) as Record<typeof names[number], Artifact>;
  const workDir = await mkdtemp(join(tmpdir(), "intracampus-b05-local-"));
  const output = resolve(process.argv[2] ?? join(workDir, "evidence.json"));
  assert.notEqual(output.toLowerCase(), join(root, "deployments/intracampus.json").toLowerCase());
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn(process.env.ANVIL_BIN ?? "anvil", [
    "--host", "127.0.0.1", "--port", String(port), "--chain-id", "20261", "--balance", "100000", "--silent",
  ], { stdio: "ignore", windowsHide: true });
  let spawnError: Error | undefined;
  anvil.on("error", (error) => { spawnError = error; });
  const stopAnvil = () => { anvil.kill(); };
  process.once("exit", stopAnvil);
  const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 50;
  let server: Server | undefined;
  let journal: GrantSeedJournal | undefined;
  try {
    stage = "start-local-anvil";
    let client = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      assert.equal(anvil.exitCode, null, "Anvil exited during startup");
      try { client = String(await provider.send("web3_clientVersion", [])); break; }
      catch { await delay(100); }
    }
    assert.match(client, /anvil/i);
    assert.equal(BigInt(await provider.send("eth_chainId", [])), 20261n);
    const signers = await Promise.all(Array.from({ length: 7 }, (_, index) => provider.getSigner(index)));
    const accounts = await Promise.all(signers.map((signer) => signer.getAddress()));
    // The one locally signed seed key is random, funded only on this ephemeral chain, and never serialized.
    const issuer = new Wallet(Wallet.createRandom().privateKey, provider);
    await (await signers[0].sendTransaction({ to: issuer.address, value: 6000n * unit })).wait();
    const deployed: Partial<Record<typeof names[number], PublicContract>> = {};
    const deployReceipts: ReturnType<typeof publicReceipt>[] = [];
    async function deploy(name: typeof names[number], args: unknown[]): Promise<Contract> {
      const artifact = artifacts[name];
      const instance = await new ContractFactory(artifact.abi as InterfaceAbi, artifact.bytecode.object, signers[0]).deploy(...args);
      const receipt = await instance.deploymentTransaction()!.wait(1, 60_000);
      assert(receipt && receipt.status === 1);
      const address = await instance.getAddress();
      deployed[name] = {
        address, abiVersion: 1, abi: artifact.abi, transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
        runtimeCodeHash: keccak256(await provider.getCode(address)),
      };
      deployReceipts.push(publicReceipt(receipt));
      return new Contract(address, artifact.abi as InterfaceAbi, signers[0]);
    }

    stage = "deploy-real-contracts";
    const sbt = await deploy("StudentSBTIdentity", [accounts[0]]);
    const registry = await deploy("CampusPaymentRegistry", [accounts[0], accounts[1], await sbt.getAddress()]);
    const vault = await deploy("PurposeBoundGrantVault", [issuer.address, await registry.getAddress()]);
    const configureReceipts = [];
    for (const [merchant, category] of [[accounts[4], parking], [accounts[5], food]]) {
      const receipt = await (await registry.setMerchantCategory(merchant, category, true)).wait(1, 60_000);
      assert(receipt && receipt.status === 1);
      configureReceipts.push(publicReceipt(receipt));
    }
    const manifest = requireDeployment({
      schemaVersion: 1, status: "deployed", chainId: 20261, abiVersion: 1, environment: "local-anvil",
      contracts: deployed,
      roles: { deployer: accounts[0], sbtIssuer: accounts[0], grantIssuer: issuer.address, posSigner: accounts[1] },
      merchants: { parking: { address: accounts[4], category: parking }, canteen: { address: accounts[5], category: food } },
    }, { allowLocal: true });
    const timestamp = (await provider.getBlock("latest"))!.timestamp;
    const config = parseSeedConfig({
      schemaVersion: 1, chainId: 20261, funder: accounts[0],
      normal: { address: accounts[2], targetBalanceWei: (10000n * unit).toString() },
      student: { address: accounts[3], targetBalanceWei: (10000n * unit).toString(), expiresAt: String(timestamp + 86400) },
    });
    const accountsPath = join(workDir, "demo-accounts.json");
    const manifestPath = join(workDir, "deployment.local-anvil.json");
    await writeFile(accountsPath, JSON.stringify({
      schemaVersion: 1, chainId: config.chainId, funder: config.funder,
      normal: { address: config.normal.address, targetBalanceWei: config.normal.targetBalanceWei.toString() },
      student: { address: config.student.address, targetBalanceWei: config.student.targetBalanceWei.toString(), expiresAt: config.student.expiresAt.toString() },
    }));
    await writeFile(manifestPath, JSON.stringify(manifest));
    const reader = new GrantsReader(provider, manifest);
    const transport = createGrantSeedTransport(provider, issuer, manifest);
    const journalPath = join(workDir, "grants.sqlite");
    journal = new GrantSeedJournal(journalPath);
    async function runCli(apply: boolean) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        /^(path|systemroot|windir|userprofile|home|homedrive|homepath|temp|tmp|localappdata|appdata|comspec|number_of_processors|processor_architecture)$/i.test(key)));
      const result = await exec(process.execPath, ["scripts/seed-grants.ts", "--accounts", accountsPath,
        "--deployment", manifestPath, "--journal", journalPath, "--allow-local", ...(apply ? ["--apply"] : [])], {
        cwd: join(root, "backend"), windowsHide: true, timeout: 60_000,
        env: { ...env, INTRACAMPUS_RPC_URL: rpcUrl, ...(apply ? { SEED_GRANT_ISSUER_PRIVATE_KEY: issuer.privateKey } : {}) },
      });
      assert.equal((result.stdout + result.stderr).includes(issuer.privateKey), false);
      return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    }
    const service = new GrantsService({ rpcUrl, deployment: manifest, allowLocal: true, provider });
    server = createApp(rpcUrl, undefined, undefined, service).listen(0, "127.0.0.1");
    await once(server, "listening");
    const httpAddress = server.address();
    assert(httpAddress && typeof httpAddress !== "string");
    const httpBase = `http://127.0.0.1:${httpAddress.port}`;
    async function lookup(txHash?: string): Promise<GrantLookup> {
      const response = await fetch(`${httpBase}/api/grants/${config.student.address}${txHash ? `?txHash=${txHash}` : ""}`);
      const body = await response.json() as GrantLookup;
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(body.beneficiary.toLowerCase(), config.student.address.toLowerCase());
      assert.equal(body.chainId, 20261);
      assert.equal(body.vaultAddress.toLowerCase(), manifest.contracts.PurposeBoundGrantVault.address.toLowerCase());
      return body;
    }

    stage = "dry-run-no-transactions";
    const beforeDryRun = await provider.getTransactionCount(issuer.address);
    const planned = await seedGrant({ config, reader });
    assert.equal(planned.mode, "dry-run");
    assert.equal(planned.status, "planned");
    const cliPlanned = await runCli(false);
    assert(cliPlanned.some((event) => event.status === "planned" && event.mode === "dry-run"));
    assert.equal(await provider.getTransactionCount(issuer.address), beforeDryRun);
    assert.equal((await lookup()).balanceWei, "0");

    stage = "seed-and-read-http-5000";
    const issued = await seedGrant({ config, reader, journal, transport, apply: true });
    assert.equal(issued.status, "confirmed");
    assert(issued.transactionHash);
    const issuedReceipt = await provider.getTransactionReceipt(issued.transactionHash);
    assert(issuedReceipt && issuedReceipt.status === 1);
    const funded = await lookup(issued.transactionHash);
    assert.equal(funded.balanceWei, (5000n * unit).toString());
    assert.equal(funded.transaction?.status, "verified");
    assert.equal(funded.transaction.events[0].event, "GrantIssued");
    assert.equal(funded.transaction.events[0].amountWei, (5000n * unit).toString());
    assert.equal(funded.allowedMerchants[0].allowed, true);
    const afterFirstSeedNonce = await provider.getTransactionCount(issuer.address);
    const repeated = await seedGrant({ config, reader, journal, transport, apply: true });
    assert.equal(repeated.status, "already-issued");
    assert.equal(await provider.getTransactionCount(issuer.address), afterFirstSeedNonce);

    stage = "student-spend-and-read-http-4000";
    const studentVault = new Contract(await vault.getAddress(), artifacts.PurposeBoundGrantVault.abi as InterfaceAbi, signers[3]);
    const merchantBefore = await provider.getBalance(accounts[5]);
    const spentReceipt = await (await studentVault.spend(accounts[5], food, 1000n * unit)).wait(1, 60_000);
    assert(spentReceipt && spentReceipt.status === 1);
    const spent = await lookup(spentReceipt.hash);
    assert.equal(spent.balanceWei, (4000n * unit).toString());
    assert.equal(spent.transaction?.status, "verified");
    assert.equal(spent.transaction.events[0].event, "GrantSpent");
    assert.equal(spent.transaction.events[0].amountWei, (1000n * unit).toString());
    assert.equal(spent.transaction.events[0].merchant?.toLowerCase(), accounts[5].toLowerCase());
    assert.equal(await provider.getBalance(accounts[5]), merchantBefore + 1000n * unit);

    stage = "restart-seed-does-not-refill";
    journal.close();
    journal = new GrantSeedJournal(journalPath);
    const restarted = await seedGrant({ config, reader, journal, transport, apply: true });
    assert.equal(restarted.status, "already-issued");
    const cliRestarted = await runCli(true);
    assert(cliRestarted.some((event) => event.status === "already-issued" && event.mode === "apply"));
    assert.equal(await provider.getTransactionCount(issuer.address), afterFirstSeedNonce);
    assert.equal((await lookup()).balanceWei, (4000n * unit).toString());

    stage = "rejected-real-transactions-preserve-grant";
    const rejections: { label: string; expectedError: string; receipt: ReturnType<typeof publicReceipt>;
      remainingWei: string; lookup: { error: { code: string } } }[] = [];
    async function rejectedSpend(label: string, merchant: string, category: string, expectedError: string) {
      const before = {
        grant: await vault.balances(accounts[3], food) as bigint,
        totalAllocated: await vault.totalAllocated() as bigint,
        vault: await provider.getBalance(await vault.getAddress()),
        merchant: await provider.getBalance(merchant),
      };
      await assert.rejects(studentVault.spend.staticCall(merchant, category, unit), (error: unknown) => {
        const data = (error as { data?: string }).data;
        return typeof data === "string" && vault.interface.parseError(data)?.name === expectedError;
      });
      // Manual gas avoids an estimate rejecting locally: this deliberately mines a reverted transaction.
      const transaction = await studentVault.spend(merchant, category, unit, { gasLimit: 200000n });
      let rejected = false;
      try { await transaction.wait(1, 60_000); } catch { rejected = true; }
      assert(rejected, "The actual transaction must revert");
      const receipt = await provider.getTransactionReceipt(transaction.hash);
      assert(receipt && receipt.status === 0);
      assert.deepEqual({
        grant: await vault.balances(accounts[3], food), totalAllocated: await vault.totalAllocated(),
        vault: await provider.getBalance(await vault.getAddress()), merchant: await provider.getBalance(merchant),
      }, before);
      assert.equal((await lookup()).balanceWei, (4000n * unit).toString());
      const lookupResponse = await fetch(`${httpBase}/api/grants/${accounts[3]}?txHash=${transaction.hash}`);
      const lookupBody = await lookupResponse.json() as { error: { code: string } };
      assert.equal(lookupResponse.status, 422);
      assert.equal(lookupBody.error.code, "TX_REVERTED");
      rejections.push({ label, expectedError, receipt: publicReceipt(receipt), remainingWei: before.grant.toString(), lookup: lookupBody });
    }
    await rejectedSpend("parking merchant cannot use FOOD", accounts[4], food, "InvalidMerchant");
    await rejectedSpend("unallowed personal wallet cannot receive FOOD", accounts[6], food, "InvalidMerchant");
    await rejectedSpend("FOOD grant cannot fund PARKING", accounts[4], parking, "InsufficientGrantBalance");

    stage = "write-public-local-evidence";
    const sourceSha256 = Object.fromEntries(await Promise.all([
      ...names.map((name) => `contracts/src/${name}.sol`),
      "backend/scripts/seed-grants.ts", "backend/src/modules/grants/grants.rpc.ts",
      "backend/src/modules/grants/grants.seed-repository.ts", "backend/src/modules/grants/grants.service.ts",
    ].map(async (path) => [path, createHash("sha256").update((await readFile(join(root, path), "utf8")).replaceAll("\r\n", "\n")).digest("hex")])));
    const evidence = {
      evidence: "LOCAL ANVIL EVM ONLY; not Avalanche L1 evidence", generatedAt: new Date().toISOString(),
      chainId: 20261, client, sourceHashNormalization: "UTF-8 with LF line endings", sourceSha256,
      deployment: manifest satisfies DeployedManifest, deployReceipts, configureReceipts,
      seed: { planned, cliPlanned, issued, repeated, restarted, cliRestarted,
        additionalTransactionsAfterRepeat: 0, additionalTransactionsAfterRestart: 0 },
      grant: { issuedReceipt: publicReceipt(issuedReceipt), spentReceipt: publicReceipt(spentReceipt), funded, spent,
        remainingWei: "4000000000000000000000", merchantIncreaseWei: "1000000000000000000000", rejections },
      note: "Contracts are fresh local deployments; ephemeral Anvil is stopped after this run. Rejected transactions are mined reverts, not only simulations. No key, raw signed transaction, or operator RPC is included.",
    };
    const serialized = JSON.stringify(evidence, null, 2) + "\n";
    assert.equal(serialized.includes(issuer.privateKey), false);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, serialized, { flag: "wx" });
    console.log(`B05 local EVM: seed twice, HTTP 5000 → spend 1000 → HTTP 4000, restart without refill and three mined reverts passed.\nEvidence: ${output}`);
  } finally {
    journal?.close();
    if (server) await new Promise<void>((done, fail) => server!.close((error) => error ? fail(error) : done()));
    provider.destroy();
    const exited = anvil.exitCode === null ? once(anvil, "exit") : Promise.resolve();
    stopAnvil();
    await exited;
    process.removeListener("exit", stopAnvil);
  }
}

main().catch(() => {
  console.error(`B05_LOCAL_EVIDENCE_FAILED at ${stage}: inspect the local implementation and artifacts. No L1 endpoint was used.`);
  process.exitCode = 1;
});
