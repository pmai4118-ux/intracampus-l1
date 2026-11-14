import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readlink, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { AbiCoder, Interface, JsonRpcProvider, ZeroHash, getAddress, getCreateAddress, keccak256 } from "ethers";
import libraryFixture from "../../docs/fixtures/library-v1.json" with { type: "json" };
import { verifyRuntime } from "./export-deployment.mjs";
import { loadVerifiedArtifact } from "./load-verified-artifact.mjs";

export const LIBRARY_CONTRACT_NAME = "LibraryDepositEscrow";

const CHAIN_ID = libraryFixture.network.chainId;
const root = fileURLToPath(new URL("../../", import.meta.url));
const coder = AbiCoder.defaultAbiCoder();
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const NONZERO_UINT_RE = /^[1-9][0-9]*$/;
const UINT_RE = /^(?:0|[1-9][0-9]*)$/;

const POLICY_GETTERS = {
  APPROVAL_WINDOW: BigInt(libraryFixture.policy.approvalWindowSeconds),
  LOAN_DURATION: BigInt(libraryFixture.policy.loanDurationSeconds),
  GRACE_PERIOD: BigInt(libraryFixture.policy.gracePeriodSeconds),
  LATE_FEE_INTERVAL: BigInt(libraryFixture.policy.lateFeeIntervalSeconds),
  LATE_FEE_PER_INTERVAL: BigInt(libraryFixture.policy.lateFeePerIntervalWei),
  MAX_LATE_FEE: BigInt(libraryFixture.policy.maxLateFeeWei),
  FULL_DEPOSIT_RETENTION_AFTER: BigInt(libraryFixture.policy.fullDepositRetentionAfterSeconds),
};

const POLICY_SPEC = {
  depositWei: String(libraryFixture.policy.depositWei),
  approvalWindowSeconds: libraryFixture.policy.approvalWindowSeconds,
  loanDurationSeconds: libraryFixture.policy.loanDurationSeconds,
  gracePeriodSeconds: libraryFixture.policy.gracePeriodSeconds,
  lateFeeIntervalSeconds: libraryFixture.policy.lateFeeIntervalSeconds,
  lateFeePerIntervalWei: String(libraryFixture.policy.lateFeePerIntervalWei),
  maxLateFeeWei: String(libraryFixture.policy.maxLateFeeWei),
  fullDepositRetentionAfterSeconds: libraryFixture.policy.fullDepositRetentionAfterSeconds,
};

function normalizeAbiEntry(entry) {
  assert(entry && typeof entry === "object" && !Array.isArray(entry), "INVALID_LIBRARY_DEPLOYMENT");
  const signature = `${entry.name ?? "constructor"}(${(entry.inputs ?? []).map(({ type }) => type).join(",")})`;
  const inputs = (entry.inputs ?? []).map(({ name = "", type, indexed }) => `${name}:${type}${indexed ? ":indexed" : ""}`).join("|");
  const outputs = (entry.outputs ?? []).map(({ name = "", type }) => `${name}:${type}`).join("|") || "-";
  if (entry.type === "constructor") return `constructor ${signature}:${entry.stateMutability}:inputs(${inputs})`;
  if (entry.type === "function") return `function ${signature}:${entry.stateMutability}:inputs(${inputs}):outputs(${outputs})`;
  if (entry.type === "event") return `event ${signature}:anonymous=${entry.anonymous ?? false}:inputs(${inputs})`;
  if (entry.type === "error") return `error ${signature}:inputs(${inputs})`;
  return `${entry.type} ${signature}`;
}

const EXPECTED_ABI_KEYS = libraryFixture.abi.map(normalizeAbiEntry).sort();

const hex = (value) => {
  assert.equal(typeof value, "string");
  assert.match(value, /^0x(?:[a-f\d]{2})*$/i);
  return value.toLowerCase();
};
const hash = (value) => {
  assert.match(value ?? "", HASH_RE);
  return value.toLowerCase();
};
const nonZeroHash = (value, label = "hash") => {
  const result = hash(value);
  assert.notEqual(result, ZeroHash, `Zero ${label}`);
  return result;
};
const address = (value) => {
  assert.equal(typeof value, "string");
  assert.match(value, ADDRESS_RE);
  const result = getAddress(value);
  assert.notEqual(result, "0x0000000000000000000000000000000000000000", "Zero address");
  return result;
};
const sameAddress = (a, b) => address(a).toLowerCase() === address(b).toLowerCase();
const integer = (value) => {
  const n = BigInt(value);
  assert(n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(n);
};

function assertValidObject(value, code = "INVALID_LIBRARY_DEPLOYMENT") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value;
}

function isAddress(value) {
  return typeof value === "string" && ADDRESS_RE.test(value) && !/^0x0{40}$/i.test(value);
}

function isHash(value) {
  return typeof value === "string" && HASH_RE.test(value) && !/^0x0{64}$/i.test(value);
}

function validateLibraryAbi(abi) {
  if (!Array.isArray(abi) || abi.length !== EXPECTED_ABI_KEYS.length) {
    throw new Error("INVALID_LIBRARY_DEPLOYMENT");
  }
  const actual = abi.map(normalizeAbiEntry).sort();
  if (actual.some((entry, index) => entry !== EXPECTED_ABI_KEYS[index])) {
    throw new Error("INVALID_LIBRARY_DEPLOYMENT");
  }
}

function collectBaseAddresses(baseManifest) {
  const known = new Set();
  for (const group of [baseManifest?.contracts, baseManifest?.merchants]) {
    if (!group || typeof group !== "object") continue;
    for (const item of Object.values(group)) {
      if (isAddress(item?.address)) known.add(item.address.toLowerCase());
    }
  }
  if (baseManifest?.roles && typeof baseManifest.roles === "object") {
    for (const item of Object.values(baseManifest.roles)) {
      if (isAddress(item)) known.add(item.toLowerCase());
    }
  }
  return known;
}

function validateDeployedLibrarySection(lib, { allowLocal = false, baseAddresses = new Set() } = {}) {
  assertValidObject(lib);
  if (
    lib.schemaVersion !== 1 ||
    lib.abiVersion !== 1 ||
    lib.chainId !== CHAIN_ID ||
    !(lib.environment === "avalanche-l1" || (allowLocal && lib.environment === "local-anvil"))
  ) {
    throw new Error("INVALID_LIBRARY_DEPLOYMENT");
  }

  const verifiedAt = assertValidObject(lib.verifiedAt);
  if (!Number.isSafeInteger(verifiedAt.blockNumber) || verifiedAt.blockNumber < 1 || !isHash(verifiedAt.blockHash)) {
    throw new Error("INVALID_LIBRARY_DEPLOYMENT");
  }

  const escrow = assertValidObject(lib.escrow);
  if (
    !isAddress(escrow.address) ||
    escrow.abiVersion !== 1 ||
    !isHash(escrow.transactionHash) ||
    !isHash(escrow.blockHash) ||
    !isHash(escrow.runtimeCodeHash) ||
    !Number.isSafeInteger(escrow.blockNumber) ||
    escrow.blockNumber < 1
  ) {
    throw new Error("INVALID_LIBRARY_DEPLOYMENT");
  }
  validateLibraryAbi(escrow.abi);

  const roles = assertValidObject(lib.roles);
  const escrowLower = escrow.address.toLowerCase();
  const roleLowers = new Set();
  for (const key of ["deployer", "administrator", "librarian"]) {
    const role = roles[key];
    if (!isAddress(role) || role.toLowerCase() === escrowLower) {
      throw new Error("INVALID_LIBRARY_DEPLOYMENT");
    }
    roleLowers.add(role.toLowerCase());
  }

  if (!isAddress(lib.treasury)) throw new Error("INVALID_LIBRARY_DEPLOYMENT");
  const treasuryLower = lib.treasury.toLowerCase();
  if (
    treasuryLower === escrowLower ||
    roleLowers.has(treasuryLower) ||
    baseAddresses.has(escrowLower) ||
    baseAddresses.has(treasuryLower)
  ) {
    throw new Error("INVALID_LIBRARY_DEPLOYMENT");
  }

  const policy = assertValidObject(lib.policy);
  for (const [key, expected] of Object.entries(POLICY_SPEC)) {
    if (policy[key] !== expected) throw new Error("INVALID_LIBRARY_DEPLOYMENT");
  }

  if (!Array.isArray(lib.books) || lib.books.length === 0) throw new Error("INVALID_LIBRARY_DEPLOYMENT");
  const seenBooks = new Set();
  for (const entry of lib.books) {
    const book = assertValidObject(entry);
    if (!isHash(book.bookId)) throw new Error("INVALID_LIBRARY_DEPLOYMENT");
    const bookId = book.bookId.toLowerCase();
    if (seenBooks.has(bookId)) throw new Error("INVALID_LIBRARY_DEPLOYMENT");
    seenBooks.add(bookId);
    if (
      book.depositWei !== POLICY_SPEC.depositWei ||
      typeof book.replacementPriceWei !== "string" ||
      !NONZERO_UINT_RE.test(book.replacementPriceWei) ||
      book.sealed !== true
    ) {
      throw new Error("INVALID_LIBRARY_DEPLOYMENT");
    }
  }

  if (!Array.isArray(lib.seedTransactions) || lib.seedTransactions.length !== lib.books.length * 2) {
    throw new Error("INVALID_LIBRARY_DEPLOYMENT");
  }
  const txHashes = new Set();
  for (const entry of lib.seedTransactions) {
    const tx = assertValidObject(entry);
    if (
      !["seedBookTerms", "sealBookTerms"].includes(String(tx.type)) ||
      !isHash(tx.bookId) ||
      !seenBooks.has(tx.bookId.toLowerCase()) ||
      !isHash(tx.transactionHash) ||
      txHashes.has(tx.transactionHash.toLowerCase()) ||
      !isHash(tx.blockHash) ||
      !Number.isSafeInteger(tx.blockNumber) ||
      tx.blockNumber < 1
    ) {
      throw new Error("INVALID_LIBRARY_DEPLOYMENT");
    }
    txHashes.add(tx.transactionHash.toLowerCase());
  }
}

/** Browser-safe lookup of the Library deployment block; accepts either a base or extended manifest. */
export function getLibraryDeployment(value) {
  const data = assertValidObject(value);
  if (
    data.schemaVersion !== 1 ||
    data.abiVersion !== 1 ||
    data.chainId !== CHAIN_ID ||
    !["unconfigured", "deployed"].includes(String(data.status))
  ) {
    throw new Error("INVALID_LIBRARY_DEPLOYMENT");
  }
  if (data.library === undefined) {
    return {
      schemaVersion: 1,
      status: "unconfigured",
      chainId: CHAIN_ID,
      abiVersion: 1,
      environment: null,
      escrow: null,
      roles: null,
      treasury: null,
      policy: structuredClone(POLICY_SPEC),
      books: [],
      seedTransactions: [],
    };
  }
  const lib = assertValidObject(data.library);
  if (lib.schemaVersion !== 1 || lib.abiVersion !== 1 || lib.chainId !== CHAIN_ID || !["unconfigured", "deployed"].includes(String(lib.status))) {
    throw new Error("INVALID_LIBRARY_DEPLOYMENT");
  }
  if (lib.status === "unconfigured") return lib;
  requireLibraryDeployment(data, { allowLocal: true });
  return lib;
}

/** Require a verified Library deployment section, opt-in for local-anvil evidence. */
export function requireLibraryDeployment(value, { allowLocal = false } = {}) {
  const data = assertValidObject(value);
  if (data.library === undefined || data.library === null) {
    throw new Error("LIBRARY_NOT_CONFIGURED");
  }
  const lib = assertValidObject(data.library);
  if (lib.status !== "deployed") {
    throw new Error("LIBRARY_NOT_CONFIGURED");
  }
  if (
    data.schemaVersion !== 1 ||
    data.abiVersion !== 1 ||
    data.chainId !== CHAIN_ID ||
    data.status !== "deployed" ||
    data.environment !== lib.environment
  ) {
    throw new Error("INVALID_LIBRARY_DEPLOYMENT");
  }
  validateDeployedLibrarySection(lib, { allowLocal, baseAddresses: collectBaseAddresses(data) });
  return data;
}

export function libraryDeploymentTemplate(artifactsOrArtifact, baseManifest = null) {
  const artifact = artifactsOrArtifact?.[LIBRARY_CONTRACT_NAME] ?? artifactsOrArtifact;
  assert(artifact && Array.isArray(artifact.abi) && artifact.abi.length > 0, "Missing compiled LibraryDepositEscrow ABI");
  const library = {
    schemaVersion: 1,
    status: "unconfigured",
    chainId: CHAIN_ID,
    abiVersion: 1,
    environment: null,
    escrow: {
      address: null,
      abiVersion: 1,
      abi: artifact.abi,
      transactionHash: null,
      blockNumber: null,
      blockHash: null,
      runtimeCodeHash: null,
    },
    roles: null,
    treasury: null,
    policy: structuredClone(POLICY_SPEC),
    books: [],
    seedTransactions: [],
  };
  if (baseManifest) {
    return { ...baseManifest, library };
  }
  return {
    schemaVersion: 1,
    status: "unconfigured",
    chainId: CHAIN_ID,
    abiVersion: 1,
    environment: null,
    library,
  };
}

/** Verify LibraryDepositEscrow deployment + seed/seal receipts and readbacks against an RPC node. */
export async function verifyLibraryBroadcast({ provider, broadcast, artifact, artifacts, environment, baseManifest = null }) {
  const resolvedArtifact = artifact ?? artifacts?.[LIBRARY_CONTRACT_NAME];
  assert(["avalanche-l1", "local-anvil"].includes(environment), "Explicit environment required");
  assert(resolvedArtifact && Array.isArray(resolvedArtifact.abi) && resolvedArtifact.abi.length > 0, "Missing current ABI");
  validateLibraryAbi(resolvedArtifact.abi);

  if (baseManifest !== null && baseManifest !== undefined) {
    assertValidObject(baseManifest);
    assert.equal(baseManifest.schemaVersion, 1, "Invalid base manifest schemaVersion");
    assert.equal(baseManifest.abiVersion, 1, "Invalid base manifest abiVersion");
    assert.equal(baseManifest.chainId, CHAIN_ID, "Invalid base manifest chainId");
    assert.equal(baseManifest.status, "deployed", "Base manifest must be deployed");
    assert.equal(baseManifest.environment, environment, "Base manifest environment mismatch");
  }

  assert.equal(BigInt(await provider.send("eth_chainId", [])), BigInt(CHAIN_ID), "Wrong RPC chain");
  assert.equal(integer(broadcast?.chain), CHAIN_ID, "Wrong broadcast chain");
  const client = await provider.send("web3_clientVersion", []);
  assert.equal(typeof client, "string");
  if (environment === "local-anvil") assert.match(client, /anvil/i);
  else assert(!/anvil/i.test(client), "Local Anvil cannot be published as Avalanche L1");

  const readBlock = await provider.send("eth_getBlockByNumber", ["latest", false]);
  assert(readBlock && hash(readBlock.hash) && integer(readBlock.number) > 0, "No confirmed state snapshot");

  assert(
    Array.isArray(broadcast?.transactions) &&
      broadcast.transactions.length >= 3 &&
      (broadcast.transactions.length - 1) % 2 === 0,
    "Expected deployment transaction followed by seed/seal pairs",
  );
  assert(
    Array.isArray(broadcast.receipts) && broadcast.receipts.length === broadcast.transactions.length,
    "Incomplete broadcast receipts",
  );
  assert(Array.isArray(broadcast.pending) && broadcast.pending.length === 0, "Unresolved pending transactions");

  const savedReceipts = new Map(broadcast.receipts.map((receipt) => [hash(receipt.transactionHash), receipt]));
  assert.equal(savedReceipts.size, broadcast.receipts.length, "Duplicate receipts");

  const seenTxHashes = new Set();
  const transactions = [];
  const receipts = [];
  const lastNonceBySender = new Map();

  for (let i = 0; i < broadcast.transactions.length; i++) {
    const claimed = broadcast.transactions[i];
    const txHash = hash(claimed.hash);
    assert(!seenTxHashes.has(txHash), "Duplicate transaction");
    seenTxHashes.add(txHash);

    const [tx, receipt] = await Promise.all([
      provider.send("eth_getTransactionByHash", [txHash]),
      provider.send("eth_getTransactionReceipt", [txHash]),
    ]);
    assert(tx && receipt, "Transaction has no confirmed receipt");
    assert.equal(hash(tx.hash), txHash);
    assert.equal(hash(receipt.transactionHash), txHash);
    assert.equal(BigInt(tx.chainId), BigInt(CHAIN_ID), "Wrong transaction chain");
    assert.equal(BigInt(receipt.status), 1n, "Reverted transaction");
    assert.equal(BigInt(tx.value), 0n, "Unexpected value transfer");

    const sender = address(tx.from);
    assert(sameAddress(receipt.from, sender), "Receipt sender mismatch");
    const senderKey = sender.toLowerCase();
    const txNonce = BigInt(tx.nonce);
    if (lastNonceBySender.has(senderKey)) {
      assert.equal(txNonce, lastNonceBySender.get(senderKey) + 1n, "Nonsequential nonce");
    }
    lastNonceBySender.set(senderKey, txNonce);

    const saved = savedReceipts.get(txHash);
    assert(saved, "Receipt missing from broadcast");
    assert.equal(BigInt(saved.status), 1n);
    assert.equal(hash(receipt.blockHash), hash(saved.blockHash));
    assert.equal(integer(receipt.blockNumber), integer(saved.blockNumber));
    assert.equal(hash(tx.blockHash), hash(receipt.blockHash));
    assert.equal(integer(tx.blockNumber), integer(receipt.blockNumber));
    assert(integer(receipt.blockNumber) <= integer(readBlock.number), "Deployment not included in state snapshot");
    if (i > 0) assert(integer(receipt.blockNumber) >= integer(receipts[i - 1].blockNumber), "Receipt order mismatch");

    const block = await provider.send("eth_getBlockByNumber", [receipt.blockNumber, false]);
    assert(block && hash(block.hash) === hash(receipt.blockHash), "Receipt is not canonical");

    transactions.push(tx);
    receipts.push(receipt);
  }

  // Verify transaction 0: LibraryDepositEscrow deployment + constructor args.
  const deployClaim = broadcast.transactions[0];
  const deployTx = transactions[0];
  const deployReceipt = receipts[0];
  const deploySaved = savedReceipts.get(hash(deployTx.hash));
  assert.equal(deployClaim.transactionType, "CREATE");
  assert.equal(deployClaim.contractName, LIBRARY_CONTRACT_NAME);
  assert.equal(deployTx.to, null);
  assert.equal(deployReceipt.to, null);
  assert.equal(deploySaved.to, null);
  const deployer = address(deployTx.from);
  const escrowAddress = address(deployReceipt.contractAddress);
  assert(sameAddress(deployClaim.contractAddress, escrowAddress) && sameAddress(deploySaved.contractAddress, escrowAddress));
  assert(sameAddress(escrowAddress, getCreateAddress({ from: deployer, nonce: deployTx.nonce })), "Unexpected creation address");

  const bytecode = hex(resolvedArtifact.bytecode.object);
  const deployInput = hex(deployTx.input);
  assert(bytecode.length > 2 && deployInput.startsWith(bytecode), "Creation bytecode differs from current source");
  const ctorTypes = resolvedArtifact.abi.find((entry) => entry.type === "constructor")?.inputs.map((entry) => entry.type) ?? [];
  assert.deepEqual(ctorTypes, ["address", "address", "address"], "Unexpected constructor signature");
  const [administrator, librarian, treasury] = [...coder.decode(ctorTypes, `0x${deployInput.slice(bytecode.length)}`)].map(address);
  assert.equal(deployInput, `${bytecode}${coder.encode(ctorTypes, [administrator, librarian, treasury]).slice(2)}`.toLowerCase(), "Noncanonical constructor arguments");

  assert(!sameAddress(treasury, deployer) && !sameAddress(treasury, administrator) && !sameAddress(treasury, librarian) && !sameAddress(treasury, escrowAddress), "Treasury collides with role or contract");
  if (baseManifest) {
    const baseAddresses = collectBaseAddresses(baseManifest);
    assert(!baseAddresses.has(escrowAddress.toLowerCase()), "Escrow address collides with base deployment");
    assert(!baseAddresses.has(treasury.toLowerCase()), "Treasury collides with base deployment");
  }

  const runtimeCode = await provider.send("eth_getCode", [escrowAddress, readBlock.number]);
  verifyRuntime(runtimeCode, resolvedArtifact);
  const runtimeCodeHash = keccak256(runtimeCode);

  const iface = new Interface(resolvedArtifact.abi);
  const readContract = async (method, inputs = []) => {
    const result = await provider.send("eth_call", [{ to: escrowAddress, data: iface.encodeFunctionData(method, inputs) }, readBlock.number]);
    return iface.decodeFunctionResult(method, result);
  };

  assert(sameAddress((await readContract("administrator"))[0], administrator), "Administrator readback mismatch");
  assert(sameAddress((await readContract("librarian"))[0], librarian), "Librarian readback mismatch");
  assert(sameAddress((await readContract("treasury"))[0], treasury), "Treasury readback mismatch");

  for (const [getter, expectedValue] of Object.entries(POLICY_GETTERS)) {
    const [actualValue] = await readContract(getter);
    assert.equal(BigInt(actualValue), expectedValue, `Policy mismatch: ${getter}`);
  }

  // Verify remaining pairs: seedBookTerms(bookId, depositWei, replacementPriceWei) followed by sealBookTerms(bookId).
  const expectedDepositWei = BigInt(POLICY_SPEC.depositWei);
  const seenBookIds = new Set();
  const books = [];
  const seedTransactions = [];

  for (let i = 1; i < transactions.length; i += 2) {
    for (const idx of [i, i + 1]) {
      const claim = broadcast.transactions[idx];
      const tx = transactions[idx];
      const receipt = receipts[idx];
      const saved = savedReceipts.get(hash(tx.hash));
      assert.equal(claim.transactionType, "CALL");
      if (claim.contractName !== undefined) assert.equal(claim.contractName, LIBRARY_CONTRACT_NAME);
      if (claim.contractAddress !== undefined) assert(sameAddress(claim.contractAddress, escrowAddress));
      assert.equal(receipt.contractAddress, null);
      assert.equal(saved.contractAddress, null);
      assert(sameAddress(tx.to, escrowAddress) && sameAddress(receipt.to, escrowAddress) && sameAddress(saved.to, escrowAddress), "Unexpected target contract");
      assert(sameAddress(tx.from, administrator), "Seed/seal sender must be administrator");
    }

    const seedTx = transactions[i];
    const seedReceipt = receipts[i];
    const sealTx = transactions[i + 1];
    const sealReceipt = receipts[i + 1];

    const seedCall = iface.parseTransaction({ data: seedTx.input, value: 0 });
    assert(seedCall && seedCall.name === "seedBookTerms", "Expected seedBookTerms call");
    const bookId = nonZeroHash(seedCall.args[0], "bookId");
    const depositWei = BigInt(seedCall.args[1]);
    const replacementPriceWei = BigInt(seedCall.args[2]);
    assert.equal(depositWei, expectedDepositWei, "Unexpected book depositWei");
    assert(replacementPriceWei > 0n, "Zero replacementPriceWei");
    assert.equal(hex(seedTx.input), iface.encodeFunctionData("seedBookTerms", [bookId, depositWei, replacementPriceWei]).toLowerCase(), "Noncanonical seedBookTerms calldata");
    assert(!seenBookIds.has(bookId), "Duplicate seeded bookId");
    seenBookIds.add(bookId);

    const seedEvent = seedReceipt.logs
      .map((log) => {
        if (!sameAddress(log.address, escrowAddress)) return null;
        try { return iface.parseLog(log); } catch { return null; }
      })
      .find((log) =>
        log?.name === "BookTermsSeeded" &&
        hash(log.args[0]) === bookId &&
        BigInt(log.args[1]) === depositWei &&
        BigInt(log.args[2]) === replacementPriceWei,
      );
    assert(seedEvent, "Missing BookTermsSeeded log");

    const sealCall = iface.parseTransaction({ data: sealTx.input, value: 0 });
    assert(sealCall && sealCall.name === "sealBookTerms", "Expected sealBookTerms call");
    assert.equal(hash(sealCall.args[0]), bookId, "sealBookTerms bookId mismatch");
    assert.equal(hex(sealTx.input), iface.encodeFunctionData("sealBookTerms", [bookId]).toLowerCase(), "Noncanonical sealBookTerms calldata");

    const sealEvent = sealReceipt.logs
      .map((log) => {
        if (!sameAddress(log.address, escrowAddress)) return null;
        try { return iface.parseLog(log); } catch { return null; }
      })
      .find((log) => log?.name === "BookTermsSealed" && hash(log.args[0]) === bookId);
    assert(sealEvent, "Missing BookTermsSealed log");

    const [onChainDepositWei, onChainPriceWei, onChainSealed] = await readContract("bookTerms", [bookId]);
    assert.equal(BigInt(onChainDepositWei), depositWei, "On-chain book depositWei mismatch");
    assert.equal(BigInt(onChainPriceWei), replacementPriceWei, "On-chain book replacementPriceWei mismatch");
    assert.equal(Boolean(onChainSealed), true, "Book terms must be sealed on-chain");

    books.push({
      bookId,
      depositWei: depositWei.toString(),
      replacementPriceWei: replacementPriceWei.toString(),
      sealed: true,
    });
    seedTransactions.push(
      {
        type: "seedBookTerms",
        bookId,
        transactionHash: hash(seedTx.hash),
        blockNumber: integer(seedReceipt.blockNumber),
        blockHash: hash(seedReceipt.blockHash),
      },
      {
        type: "sealBookTerms",
        bookId,
        transactionHash: hash(sealTx.hash),
        blockNumber: integer(sealReceipt.blockNumber),
        blockHash: hash(sealReceipt.blockHash),
      },
    );
  }

  // Re-verify chain and canonical blocks after all readbacks.
  assert.equal(BigInt(await provider.send("eth_chainId", [])), BigInt(CHAIN_ID));
  for (const receipt of receipts) {
    const block = await provider.send("eth_getBlockByNumber", [receipt.blockNumber, false]);
    assert(block && hash(block.hash) === hash(receipt.blockHash), "Chain changed while exporting");
  }
  const finalReadBlock = await provider.send("eth_getBlockByNumber", [readBlock.number, false]);
  assert(finalReadBlock && hash(finalReadBlock.hash) === hash(readBlock.hash), "Readback snapshot changed");

  const library = {
    schemaVersion: 1,
    status: "deployed",
    chainId: CHAIN_ID,
    abiVersion: 1,
    environment,
    generatedAt: new Date().toISOString(),
    verifiedAt: {
      blockNumber: integer(readBlock.number),
      blockHash: hash(readBlock.hash),
    },
    escrow: {
      address: escrowAddress,
      abiVersion: 1,
      abi: resolvedArtifact.abi,
      transactionHash: hash(deployTx.hash),
      blockNumber: integer(deployReceipt.blockNumber),
      blockHash: hash(deployReceipt.blockHash),
      runtimeCodeHash,
    },
    roles: {
      deployer,
      administrator,
      librarian,
    },
    treasury,
    policy: structuredClone(POLICY_SPEC),
    books,
    seedTransactions,
  };

  const manifest = baseManifest
    ? { ...structuredClone(baseManifest), library }
    : {
        schemaVersion: 1,
        status: "deployed",
        chainId: CHAIN_ID,
        abiVersion: 1,
        environment,
        library,
      };

  requireLibraryDeployment(manifest, { allowLocal: environment === "local-anvil" });
  return manifest;
}

function normalizePathForComparison(targetPath) {
  const withoutExtendedPrefix = process.platform === "win32" ? targetPath.replace(/^\\\\\?\\/, "") : targetPath;
  return process.platform === "win32" ? withoutExtendedPrefix.toLowerCase() : withoutExtendedPrefix;
}

async function resolveCanonicalPath(targetPath) {
  let current = resolve(targetPath);
  const remainder = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const existingReal = await realpath(current);
      return remainder.reduceRight((acc, segment) => join(acc, segment), existingReal);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const linkStats = await lstat(current).catch((statErr) => {
        if (statErr.code === "ENOENT") return null;
        throw statErr;
      });
      if (linkStats?.isSymbolicLink()) {
        const linkTarget = await readlink(current);
        current = resolve(dirname(current), linkTarget);
        continue;
      }
      const parent = dirname(current);
      if (parent === current) {
        return remainder.reduceRight((acc, segment) => join(acc, segment), current);
      }
      remainder.push(basename(current));
      current = parent;
    }
  }
  throw new Error(`Exceeded symlink resolution depth for ${targetPath}`);
}

async function isCanonicalDeploymentPath(targetPath) {
  const [canonical, resolved] = await Promise.all([
    resolveCanonicalPath(resolve(root, "deployments/intracampus.json")),
    resolveCanonicalPath(targetPath),
  ]);
  return normalizePathForComparison(resolved) === normalizePathForComparison(canonical);
}

async function saveManifest(outputPath, manifest, replace) {
  const resolved = resolve(outputPath);
  assert(
    !(await isCanonicalDeploymentPath(resolved)),
    "Refusing to write onto canonical deployments/intracampus.json",
  );
  try {
    const previous = JSON.parse(await readFile(resolved, "utf8"));
    assert(
      replace || (previous?.status !== "deployed" && previous?.library?.status !== "deployed"),
      "Refusing to overwrite a deployed manifest without --replace",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(resolved), { recursive: true });
  const temp = `${resolved}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    await rename(temp, resolved);
  } finally {
    await unlink(temp).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function exportLibraryDeployment({
  rpcUrl,
  broadcastPath,
  outputPath,
  basePath,
  contractsDir = join(root, "contracts"),
  environment,
  template = false,
  replace = false,
}) {
  const artifact = await loadVerifiedArtifact(contractsDir, LIBRARY_CONTRACT_NAME);
  const baseManifest = basePath ? JSON.parse(await readFile(resolve(basePath), "utf8")) : null;
  let manifest;

  if (template) {
    manifest = libraryDeploymentTemplate(artifact, baseManifest);
  } else {
    const url = new URL(rpcUrl);
    assert(["http:", "https:"].includes(url.protocol) && !url.username && !url.password, "Invalid RPC URL");
    if (environment === "local-anvil") {
      assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Local evidence requires loopback RPC");
    }
    const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
    try {
      manifest = await verifyLibraryBroadcast({
        provider,
        broadcast: JSON.parse(await readFile(resolve(broadcastPath), "utf8")),
        artifact,
        environment,
        baseManifest,
      });
    } finally {
      provider.destroy();
    }
  }

  if (outputPath) await saveManifest(outputPath, manifest, replace);
  return manifest;
}

async function main() {
  const { values } = parseArgs({
    options: {
      broadcast: { type: "string" },
      output: { type: "string" },
      base: { type: "string" },
      environment: { type: "string" },
      template: { type: "boolean", default: false },
      replace: { type: "boolean", default: false },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "export-library-deployment --broadcast <run-latest.json> --environment avalanche-l1|local-anvil --output <isolated.json> [--base <core.json>] [--replace]\n" +
        "Or --template --output <unconfigured.json> [--base <core.json>]. RPC: INTRACAMPUS_RPC_URL. Never targets deployments/intracampus.json.",
    );
    return;
  }
  assert(values.output, "Explicit --output path required; see --help");
  assert(values.template ? !values.broadcast && !values.environment : values.broadcast && values.environment, "See --help");
  await exportLibraryDeployment({
    rpcUrl: process.env.INTRACAMPUS_RPC_URL,
    broadcastPath: values.broadcast,
    outputPath: values.output,
    basePath: values.base,
    environment: values.environment,
    template: values.template,
    replace: values.replace,
  });
  console.log("Library deployment manifest exported from verified artifacts and receipts.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("LIBRARY_DEPLOYMENT_EXPORT_FAILED: inspect chain, receipts, build artifact, ABI parity and sealed terms; no transaction was sent.");
    process.exitCode = 1;
  });
}
