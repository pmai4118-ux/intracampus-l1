// Synthetic RPC cases exercise Library publication gates; actual Forge/Anvil broadcast is verified via DeployLibrary.s.sol.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AbiCoder, Interface, getCreateAddress, id, keccak256, toUtf8Bytes } from "ethers";
import baseManifest from "../../deployments/intracampus.json" with { type: "json" };
import libraryFixture from "../../docs/fixtures/library-v1.json" with { type: "json" };
import { requireDeployment } from "../../packages/network/src/deployment.ts";
import {
  getLibraryDeployment as getSharedLibraryDeployment,
  requireLibraryDeployment as requireSharedLibraryDeployment,
} from "../../packages/network/src/library-deployment.ts";
import {
  LIBRARY_CONTRACT_NAME,
  exportLibraryDeployment,
  getLibraryDeployment,
  libraryDeploymentTemplate,
  requireLibraryDeployment,
  verifyLibraryBroadcast,
} from "../script/export-library-deployment.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const addr = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const coder = AbiCoder.defaultAbiCoder();

const POLICY_GETTERS = {
  APPROVAL_WINDOW: BigInt(libraryFixture.policy.approvalWindowSeconds),
  LOAN_DURATION: BigInt(libraryFixture.policy.loanDurationSeconds),
  GRACE_PERIOD: BigInt(libraryFixture.policy.gracePeriodSeconds),
  LATE_FEE_INTERVAL: BigInt(libraryFixture.policy.lateFeeIntervalSeconds),
  LATE_FEE_PER_INTERVAL: BigInt(libraryFixture.policy.lateFeePerIntervalWei),
  MAX_LATE_FEE: BigInt(libraryFixture.policy.maxLateFeeWei),
  FULL_DEPOSIT_RETENTION_AFTER: BigInt(libraryFixture.policy.fullDepositRetentionAfterSeconds),
};

function coreDeployedFixture() {
  const deployer = addr(10);
  const signer = addr(11);
  const issuer = addr(12);
  const coreNames = ["StudentSBTIdentity", "CampusPaymentRegistry", "PurposeBoundGrantVault"];
  const contracts = Object.fromEntries(coreNames.map((name, i) => [name, {
    address: getCreateAddress({ from: deployer, nonce: i }),
    abiVersion: 1,
    abi: baseManifest.contracts[name].abi,
    transactionHash: hash(100 + i),
    blockNumber: i + 1,
    blockHash: hash(200 + i),
    runtimeCodeHash: hash(300 + i),
  }]));
  return {
    schemaVersion: 1,
    status: "deployed",
    chainId: 20261,
    abiVersion: 1,
    environment: "local-anvil",
    generatedAt: "2026-11-14T00:00:00.000Z",
    verifiedAt: { blockNumber: 5, blockHash: hash(204) },
    contracts,
    roles: { deployer, sbtIssuer: issuer, grantIssuer: issuer, posSigner: signer },
    merchants: {
      parking: { address: addr(20), category: id("PARKING") },
      canteen: { address: addr(21), category: id("FOOD") },
    },
    configurationTransactions: [],
  };
}

function fixture() {
  const deployer = addr(10);
  const administrator = addr(10);
  const librarian = addr(13);
  const treasury = addr(22);
  const escrowAddress = getCreateAddress({ from: deployer, nonce: 10 });
  const artifact = {
    abi: libraryFixture.abi,
    bytecode: { object: "0x6005" },
    deployedBytecode: { object: "0x6015", immutableReferences: {} },
  };
  const iface = new Interface(artifact.abi);
  const books = [
    { bookId: id("BOOK-1"), depositWei: BigInt(libraryFixture.policy.depositWei), replacementPriceWei: 30n * 10n ** 18n, sealed: true },
    { bookId: id("BOOK-2"), depositWei: BigInt(libraryFixture.policy.depositWei), replacementPriceWei: 80n * 10n ** 18n, sealed: true },
  ];

  const txs = [];
  const receipts = [];
  const claims = [];

  const createInput = artifact.bytecode.object
    + coder.encode(["address", "address", "address"], [administrator, librarian, treasury]).slice(2);
  txs.push({
    hash: hash(1),
    from: deployer,
    to: null,
    nonce: "0xa",
    chainId: "0x4f25",
    value: "0x0",
    input: createInput,
    blockNumber: "0x1",
    blockHash: hash(101),
  });
  receipts.push({
    transactionHash: hash(1),
    status: "0x1",
    from: deployer,
    to: null,
    contractAddress: escrowAddress,
    blockNumber: "0x1",
    blockHash: hash(101),
    logs: [],
  });
  claims.push({
    hash: hash(1),
    transactionType: "CREATE",
    contractName: LIBRARY_CONTRACT_NAME,
    contractAddress: escrowAddress,
  });

  let nonce = 11;
  let block = 2;
  for (const book of books) {
    const seedTxHash = hash(nonce);
    const seedInput = iface.encodeFunctionData("seedBookTerms", [book.bookId, book.depositWei, book.replacementPriceWei]);
    txs.push({
      hash: seedTxHash,
      from: administrator,
      to: escrowAddress,
      nonce: `0x${nonce.toString(16)}`,
      chainId: "0x4f25",
      value: "0x0",
      input: seedInput,
      blockNumber: `0x${block.toString(16)}`,
      blockHash: hash(100 + block),
    });
    const seedLog = iface.encodeEventLog(iface.getEvent("BookTermsSeeded"), [book.bookId, book.depositWei, book.replacementPriceWei]);
    receipts.push({
      transactionHash: seedTxHash,
      status: "0x1",
      from: administrator,
      to: escrowAddress,
      contractAddress: null,
      blockNumber: `0x${block.toString(16)}`,
      blockHash: hash(100 + block),
      logs: [{ address: escrowAddress, ...seedLog }],
    });
    claims.push({
      hash: seedTxHash,
      transactionType: "CALL",
      contractName: LIBRARY_CONTRACT_NAME,
      contractAddress: escrowAddress,
    });
    nonce += 1;
    block += 1;

    const sealTxHash = hash(nonce);
    const sealInput = iface.encodeFunctionData("sealBookTerms", [book.bookId]);
    txs.push({
      hash: sealTxHash,
      from: administrator,
      to: escrowAddress,
      nonce: `0x${nonce.toString(16)}`,
      chainId: "0x4f25",
      value: "0x0",
      input: sealInput,
      blockNumber: `0x${block.toString(16)}`,
      blockHash: hash(100 + block),
    });
    const sealLog = iface.encodeEventLog(iface.getEvent("BookTermsSealed"), [book.bookId]);
    receipts.push({
      transactionHash: sealTxHash,
      status: "0x1",
      from: administrator,
      to: escrowAddress,
      contractAddress: null,
      blockNumber: `0x${block.toString(16)}`,
      blockHash: hash(100 + block),
      logs: [{ address: escrowAddress, ...sealLog }],
    });
    claims.push({
      hash: sealTxHash,
      transactionType: "CALL",
      contractName: LIBRARY_CONTRACT_NAME,
      contractAddress: escrowAddress,
    });
    nonce += 1;
    block += 1;
  }

  const latestBlockHex = `0x${(block - 1).toString(16)}`;
  const state = {
    chain: "0x4f25",
    client: "anvil/v1.7.1",
    canonical: true,
    codeOverride: null,
    missing: false,
    administratorOverride: null,
    librarianOverride: null,
    treasuryOverride: null,
    policyOverrides: {},
    unsealedBookIndex: null,
    priceMismatchBookIndex: null,
  };

  const broadcast = { chain: 20261, pending: [], transactions: claims, receipts: structuredClone(receipts) };
  const provider = {
    send: async (method, params) => {
      if (method === "eth_chainId") return state.chain;
      if (method === "web3_clientVersion") return state.client;
      if (method === "eth_getTransactionByHash") return txs.find((tx) => tx.hash === params[0]);
      if (method === "eth_getTransactionReceipt") return state.missing ? null : receipts.find((r) => r.transactionHash === params[0]);
      if (method === "eth_getBlockByNumber") {
        const number = params[0] === "latest" ? latestBlockHex : params[0];
        const match = receipts.find((r) => r.blockNumber === number);
        return { number, hash: state.canonical ? match.blockHash : hash(999) };
      }
      if (method === "eth_getCode") {
        assert.equal(params[0].toLowerCase(), escrowAddress.toLowerCase());
        return state.codeOverride ?? artifact.deployedBytecode.object;
      }
      if (method === "eth_call") {
        assert.equal(params[0].to.toLowerCase(), escrowAddress.toLowerCase());
        const decoded = iface.parseTransaction({ data: params[0].data });
        if (decoded.name === "administrator") return iface.encodeFunctionResult("administrator", [state.administratorOverride ?? administrator]);
        if (decoded.name === "librarian") return iface.encodeFunctionResult("librarian", [state.librarianOverride ?? librarian]);
        if (decoded.name === "treasury") return iface.encodeFunctionResult("treasury", [state.treasuryOverride ?? treasury]);
        if (decoded.name in POLICY_GETTERS) {
          return iface.encodeFunctionResult(decoded.name, [state.policyOverrides[decoded.name] ?? POLICY_GETTERS[decoded.name]]);
        }
        if (decoded.name === "bookTerms") {
          const idx = books.findIndex((b) => b.bookId.toLowerCase() === decoded.args[0].toLowerCase());
          assert(idx >= 0, "unexpected bookTerms query");
          const b = books[idx];
          const price = state.priceMismatchBookIndex === idx ? b.replacementPriceWei + 1n : b.replacementPriceWei;
          const sealed = state.unsealedBookIndex === idx ? false : b.sealed;
          return iface.encodeFunctionResult("bookTerms", [b.depositWei, price, sealed]);
        }
        throw new Error(`Unexpected eth_call ${decoded.name}`);
      }
      throw new Error(`Unexpected test RPC ${method}`);
    },
  };

  return { provider, broadcast, artifact, environment: "local-anvil", state, txs, receipts, books, escrowAddress };
}

test("compiled LibraryDepositEscrow artifact ABI matches frozen fixture when built", async () => {
  const artifactPath = join(root, "contracts/out/LibraryDepositEscrow.sol/LibraryDepositEscrow.json");
  if (!existsSync(artifactPath)) return;
  const compiled = JSON.parse(await readFile(artifactPath, "utf8"));
  const normalize = (entry) => {
    const signature = `${entry.name ?? "constructor"}(${(entry.inputs ?? []).map(({ type }) => type).join(",")})`;
    const inputs = (entry.inputs ?? []).map(({ name = "", type, indexed }) => `${name}:${type}${indexed ? ":indexed" : ""}`).join("|");
    const outputs = (entry.outputs ?? []).map(({ name = "", type }) => `${name}:${type}`).join("|") || "-";
    if (entry.type === "constructor") return `constructor ${signature}:${entry.stateMutability}:inputs(${inputs})`;
    if (entry.type === "function") return `function ${signature}:${entry.stateMutability}:inputs(${inputs}):outputs(${outputs})`;
    if (entry.type === "event") return `event ${signature}:anonymous=${entry.anonymous ?? false}:inputs(${inputs})`;
    if (entry.type === "error") return `error ${signature}:inputs(${inputs})`;
    return `${entry.type} ${signature}`;
  };
  assert.deepEqual(compiled.abi.map(normalize).sort(), libraryFixture.abi.map(normalize).sort());
});

test("verified library deployment records ABI, tx/block/runtime hashes, roles, treasury and terms without secrets", async () => {
  const f = fixture();
  const actual = await verifyLibraryBroadcast(f);
  assert.equal(actual.schemaVersion, 1);
  assert.equal(actual.chainId, 20261);
  assert.equal(actual.environment, "local-anvil");
  assert.equal(actual.library.status, "deployed");
  assert.equal(actual.library.escrow.address.toLowerCase(), f.escrowAddress.toLowerCase());
  assert.deepEqual(actual.library.escrow.abi, libraryFixture.abi);
  assert.equal(actual.library.escrow.runtimeCodeHash, keccak256(f.artifact.deployedBytecode.object));
  assert.equal(actual.library.roles.deployer.toLowerCase(), addr(10));
  assert.equal(actual.library.roles.administrator.toLowerCase(), addr(10));
  assert.equal(actual.library.roles.librarian.toLowerCase(), addr(13));
  assert.equal(actual.library.treasury.toLowerCase(), addr(22));
  assert.equal(actual.library.books.length, 2);
  assert.equal(actual.library.seedTransactions.length, 4);
  assert(!JSON.stringify(actual).includes("http"));
  assert.equal(requireLibraryDeployment(actual, { allowLocal: true }).library.escrow.address, actual.library.escrow.address);
  assert.equal(requireSharedLibraryDeployment(actual, { allowLocal: true }).library.escrow.address, actual.library.escrow.address);
  assert.equal(getSharedLibraryDeployment(actual).status, "deployed");
});

test("extended manifest keeps old three-contract loader happy while Library loader rejects 3-contract-only manifest", async () => {
  const f = fixture();
  const core = coreDeployedFixture();
  const extended = await verifyLibraryBroadcast({ ...f, baseManifest: core });

  // Existing three-contract loader accepts both old 3-contract manifest and extended manifest.
  assert.equal(requireDeployment(core, { allowLocal: true }), core);
  assert.equal(requireDeployment(extended, { allowLocal: true }), extended);

  // Library loader accepts extended manifest and rejects old 3-contract manifest.
  assert.equal(requireLibraryDeployment(extended, { allowLocal: true }).library.escrow.address, extended.library.escrow.address);
  assert.equal(requireSharedLibraryDeployment(extended, { allowLocal: true }).library.escrow.address, extended.library.escrow.address);
  assert.equal(getSharedLibraryDeployment(extended).status, "deployed");
  assert.throws(() => requireLibraryDeployment(core, { allowLocal: true }), /LIBRARY_NOT_CONFIGURED/);
  assert.throws(() => requireLibraryDeployment(baseManifest, { allowLocal: true }), /LIBRARY_NOT_CONFIGURED/);
  assert.equal(getLibraryDeployment(baseManifest).status, "unconfigured");
  assert.equal(getSharedLibraryDeployment(baseManifest).status, "unconfigured");
  assert.throws(() => requireSharedLibraryDeployment(core, { allowLocal: true }), /LIBRARY_NOT_CONFIGURED/);
});

for (const [label, change] of [
  ["wrong RPC chain", (f) => { f.state.chain = "0xa869"; }],
  ["wrong broadcast chain", (f) => { f.broadcast.chain = 43113; }],
  ["pending broadcast", (f) => { f.broadcast.pending = [hash(1)]; }],
  ["missing receipt", (f) => { f.state.missing = true; }],
  ["incomplete receipt list", (f) => { f.broadcast.receipts.pop(); }],
  ["duplicate receipt", (f) => { f.broadcast.receipts[1] = f.broadcast.receipts[0]; }],
  ["duplicate transaction", (f) => { f.broadcast.transactions[1].hash = hash(1); }],
  ["reverted transaction", (f) => { f.receipts[0].status = "0x0"; }],
  ["saved receipt block mismatch", (f) => { f.broadcast.receipts[0].blockHash = hash(999); }],
  ["noncanonical block", (f) => { f.state.canonical = false; }],
  ["wrong creation sender vs deployer", (f) => { f.txs[0].from = addr(99); }],
  ["wrong seed sender vs administrator", (f) => { f.txs[1].from = addr(99); }],
  ["wrong transaction chain", (f) => { f.txs[1].chainId = "0x1"; }],
  ["unexpected value transfer", (f) => { f.txs[1].value = "0x1"; }],
  ["wrong contractName", (f) => { f.broadcast.transactions[0].contractName = "CampusPaymentRegistry"; }],
  ["creation with to", (f) => { f.txs[0].to = addr(99); }],
  ["wrong creation address", (f) => { f.receipts[0].contractAddress = addr(99); }],
  ["wrong creation bytecode", (f) => { f.txs[0].input = "0x60ff" + f.txs[0].input.slice(6); }],
  ["trailing constructor bytes", (f) => { f.txs[0].input += "00"; }],
  ["wrong runtime", (f) => { f.state.codeOverride = "0x60ff"; }],
  ["wrong administrator readback", (f) => { f.state.administratorOverride = addr(99); }],
  ["wrong librarian readback", (f) => { f.state.librarianOverride = addr(99); }],
  ["wrong treasury readback", (f) => { f.state.treasuryOverride = addr(99); }],
  ["wrong policy constant", (f) => { f.state.policyOverrides.APPROVAL_WINDOW = 100n; }],
  ["nonsequential nonce", (f) => { f.txs[2].nonce = "0x99"; }],
  ["seed at wrong target contract", (f) => { f.txs[1].to = addr(99); }],
  ["missing BookTermsSeeded log", (f) => { f.receipts[1].logs = []; }],
  ["missing BookTermsSealed log", (f) => { f.receipts[2].logs = []; }],
  ["unsealed book on readback", (f) => { f.state.unsealedBookIndex = 0; }],
  ["mismatched sealed price on readback", (f) => { f.state.priceMismatchBookIndex = 1; }],
  ["treasury equals role", (f) => {
    const input = f.artifact.bytecode.object + coder.encode(["address", "address", "address"], [addr(10), addr(13), addr(10)]).slice(2);
    f.txs[0].input = input;
    f.state.treasuryOverride = addr(10);
  }],
  ["missing seed transactions", (f) => {
    f.broadcast.transactions = f.broadcast.transactions.slice(0, 1);
    f.broadcast.receipts = f.broadcast.receipts.slice(0, 1);
  }],
]) {
  test(`verifyLibraryBroadcast refuses ${label}`, async () => {
    const f = fixture();
    change(f);
    await assert.rejects(verifyLibraryBroadcast(f));
  });
}

test("Anvil cannot be relabeled as Avalanche L1", async () => {
  const f = fixture();
  f.environment = "avalanche-l1";
  await assert.rejects(verifyLibraryBroadcast(f));
});

test("requireLibraryDeployment rejects missing/invalid escrow ABI, version, chain, role, treasury and terms", async () => {
  const f = fixture();
  const valid = await verifyLibraryBroadcast({ ...f, environment: "avalanche-l1", provider: {
    send: async (m, p) => m === "web3_clientVersion" ? "Subnet-EVM/test" : f.provider.send(m, p),
  } });
  assert.equal(requireLibraryDeployment(valid).library.environment, "avalanche-l1");

  const local = await verifyLibraryBroadcast(f);
  assert.throws(() => requireLibraryDeployment(local), /INVALID_LIBRARY_DEPLOYMENT/);
  assert.equal(requireLibraryDeployment(local, { allowLocal: true }).library.environment, "local-anvil");
  assert.throws(() => requireSharedLibraryDeployment(local), /INVALID_DEPLOYMENT/);
  assert.equal(requireSharedLibraryDeployment(local, { allowLocal: true }).library.environment, "local-anvil");

  const cases = [
    ["wrong schemaVersion", (m) => { m.library.schemaVersion = 2; }],
    ["wrong abiVersion", (m) => { m.library.abiVersion = 2; }],
    ["wrong chainId", (m) => { m.library.chainId = 43113; }],
    ["zero escrow address", (m) => { m.library.escrow.address = addr(0); }],
    ["zero librarian", (m) => { m.library.roles.librarian = addr(0); }],
    ["zero treasury", (m) => { m.library.treasury = addr(0); }],
    ["treasury equals librarian", (m) => { m.library.treasury = m.library.roles.librarian; }],
    ["missing settleReturn function", (m) => {
      m.library.escrow.abi = m.library.escrow.abi.filter((e) => e.name !== "settleReturn");
    }],
    ["deposit not payable", (m) => {
      m.library.escrow.abi.find((e) => e.name === "deposit").stateMutability = "nonpayable";
    }],
    ["wrong ReturnSettled indexed field", (m) => {
      m.library.escrow.abi.find((e) => e.name === "ReturnSettled").inputs[0].indexed = false;
    }],
    ["anonymous LoanApproved event", (m) => {
      m.library.escrow.abi.find((e) => e.name === "LoanApproved").anonymous = true;
    }],
    ["extra unapproved ABI function", (m) => {
      m.library.escrow.abi.push({ type: "function", name: "withdrawAll", inputs: [], outputs: [], stateMutability: "nonpayable" });
    }],
    ["wrong policy depositWei", (m) => { m.library.policy.depositWei = "1"; }],
    ["wrong policy approvalWindowSeconds", (m) => { m.library.policy.approvalWindowSeconds = 60; }],
    ["unsealed book", (m) => { m.library.books[0].sealed = false; }],
    ["zero replacement price", (m) => { m.library.books[0].replacementPriceWei = "0"; }],
    ["duplicate bookId", (m) => { m.library.books[1].bookId = m.library.books[0].bookId; }],
    ["empty books", (m) => { m.library.books = []; }],
    ["one book missing its seal transaction", (m) => {
      m.library.seedTransactions[1].type = "seedBookTerms";
      m.library.seedTransactions[1].transactionHash = hash(999);
    }],
  ];

  for (const [label, mutate] of cases) {
    const mutated = structuredClone(valid);
    mutate(mutated);
    assert.throws(() => requireLibraryDeployment(mutated), /INVALID_LIBRARY_DEPLOYMENT/, label);
    assert.throws(() => requireSharedLibraryDeployment(mutated, { allowLocal: true }), /INVALID_DEPLOYMENT/, `shared loader: ${label}`);
  }
});

test("library template and export safety protect canonical deployments/intracampus.json", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "library-export-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const source = "// Synthetic LibraryDepositEscrow";
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "out", `${LIBRARY_CONTRACT_NAME}.sol`), { recursive: true });
  await writeFile(join(dir, "src", `${LIBRARY_CONTRACT_NAME}.sol`), source);
  await writeFile(
    join(dir, "out", `${LIBRARY_CONTRACT_NAME}.sol`, `${LIBRARY_CONTRACT_NAME}.json`),
    JSON.stringify({
      abi: libraryFixture.abi,
      bytecode: { object: "0x6005" },
      deployedBytecode: { object: "0x6015", immutableReferences: {} },
      metadata: { sources: { [`src/${LIBRARY_CONTRACT_NAME}.sol`]: { keccak256: keccak256(toUtf8Bytes(source)) } } },
    }),
  );

  const template = libraryDeploymentTemplate({ [LIBRARY_CONTRACT_NAME]: { abi: libraryFixture.abi } });
  assert.equal(template.library.status, "unconfigured");
  assert.equal(template.library.escrow.address, null);

  const outputPath = join(dir, "library-deployment.json");
  const result = await exportLibraryDeployment({ contractsDir: dir, outputPath, template: true });
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), result);

  // Allow ordinary nested destinations (including deep >64 missing segments and isolated temp junctions).
  const nestedOutputPath = join(dir, "nested", "subdir", "library-deployment.json");
  const nestedResult = await exportLibraryDeployment({ contractsDir: dir, outputPath: nestedOutputPath, template: true });
  assert.deepEqual(JSON.parse(await readFile(nestedOutputPath, "utf8")), nestedResult);

  const deepMissingDirs = Array.from({ length: 65 }, () => "d");
  const deepNestedOutputPath = join(dir, ...deepMissingDirs, "library-deployment.json");
  const deepNestedResult = await exportLibraryDeployment({
    contractsDir: dir,
    outputPath: deepNestedOutputPath,
    template: true,
  });
  assert.deepEqual(JSON.parse(await readFile(deepNestedOutputPath, "utf8")), deepNestedResult);

  const safeTargetDir = join(dir, "safe-target");
  const safeAliasDir = join(dir, "safe-alias");
  await mkdir(safeTargetDir, { recursive: true });
  await symlink(safeTargetDir, safeAliasDir, process.platform === "win32" ? "junction" : "dir");
  const aliasedAllowedPath = join(safeAliasDir, "nested", "library-deployment.json");
  const aliasedAllowedResult = await exportLibraryDeployment({
    contractsDir: dir,
    outputPath: aliasedAllowedPath,
    template: true,
  });
  assert.deepEqual(JSON.parse(await readFile(join(safeTargetDir, "nested", "library-deployment.json"), "utf8")), aliasedAllowedResult);

  // Refuse overwriting an existing deployed manifest without --replace.
  await writeFile(outputPath, JSON.stringify({ status: "deployed", library: { status: "deployed" } }));
  await assert.rejects(exportLibraryDeployment({ contractsDir: dir, outputPath, template: true }), /overwrite/);

  // Refuse writing onto canonical deployments/intracampus.json directly or via junction/symlink aliases.
  const canonicalPath = resolve(root, "deployments/intracampus.json");
  const canonicalBefore = await readFile(canonicalPath, "utf8");
  await assert.rejects(
    exportLibraryDeployment({ contractsDir: dir, outputPath: canonicalPath, template: true, replace: true }),
    /canonical/,
  );
  assert.equal(await readFile(canonicalPath, "utf8"), canonicalBefore);

  const canonicalAliasDir = join(dir, "deployments-alias");
  try {
    await symlink(resolve(root, "deployments"), canonicalAliasDir, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "ENOTSUP", "EINVAL"].includes(error?.code)) {
      await symlink(resolve(root, "deployments"), canonicalAliasDir, "dir");
    } else {
      throw error;
    }
  }
  await assert.rejects(
    exportLibraryDeployment({
      contractsDir: dir,
      outputPath: join(canonicalAliasDir, "intracampus.json"),
      template: true,
      replace: true,
    }),
    /canonical/,
  );
  await assert.rejects(
    exportLibraryDeployment({
      contractsDir: dir,
      outputPath: join(canonicalAliasDir, "missing-subdir", "..", "intracampus.json"),
      template: true,
      replace: true,
    }),
    /canonical/,
  );
  assert.equal(await readFile(canonicalPath, "utf8"), canonicalBefore);

  // Refuse stale build artifact.
  await writeFile(join(dir, "src", `${LIBRARY_CONTRACT_NAME}.sol`), "changed after build");
  await assert.rejects(
    exportLibraryDeployment({ contractsDir: dir, outputPath, template: true, replace: true }),
    /stale/,
  );
});
