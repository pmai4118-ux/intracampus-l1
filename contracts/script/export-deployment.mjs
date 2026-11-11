import assert from "node:assert/strict";
import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { AbiCoder, Interface, JsonRpcProvider, getAddress, getCreateAddress, id, keccak256 } from "ethers";
import { loadVerifiedArtifact } from "./load-verified-artifact.mjs";

export const CONTRACT_NAMES = ["StudentSBTIdentity", "CampusPaymentRegistry", "PurposeBoundGrantVault"];
const root = fileURLToPath(new URL("../../", import.meta.url));
const coder = AbiCoder.defaultAbiCoder();
const hex = (value) => { assert.equal(typeof value, "string"); assert.match(value, /^0x(?:[a-f\d]{2})*$/i); return value.toLowerCase(); };
const hash = (value) => { assert.match(value ?? "", /^0x[a-f\d]{64}$/i); return value.toLowerCase(); };
const address = (value) => { const result = getAddress(value); assert.notEqual(result, "0x0000000000000000000000000000000000000000"); return result; };
const sameAddress = (a, b) => address(a).toLowerCase() === address(b).toLowerCase();
const integer = (value) => { const n = BigInt(value); assert(n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER)); return Number(n); };

/** Match the compiled runtime, masking only the compiler-declared immutable locations. */
export function verifyRuntime(actual, artifact) {
  const expected = Buffer.from(hex(artifact.deployedBytecode.object).slice(2), "hex");
  const observed = Buffer.from(hex(actual).slice(2), "hex");
  assert(expected.length > 0 && observed.length === expected.length, "Runtime size mismatch");
  for (const locations of Object.values(artifact.deployedBytecode.immutableReferences ?? {})) {
    for (const { start, length } of locations) {
      assert(Number.isInteger(start) && Number.isInteger(length) && start >= 0 && length > 0 && start + length <= expected.length);
      assert(expected.subarray(start, start + length).every((value) => value === 0), "Invalid immutable placeholder");
      observed.fill(0, start, start + length);
    }
  }
  assert.deepEqual(observed, expected, "Runtime differs from current artifact");
}

export function deploymentTemplate(artifacts) {
  return { schemaVersion: 1, status: "unconfigured", chainId: 20261, abiVersion: 1, environment: null,
    contracts: Object.fromEntries(CONTRACT_NAMES.map((name) => [name, { address: null, abiVersion: 1,
      abi: artifacts[name].abi, transactionHash: null, blockNumber: null, blockHash: null, runtimeCodeHash: null }])),
    roles: null, merchants: null, configurationTransactions: [] };
}

/** Verify receipts independently of Foundry's local claims. Accepts a raw RPC provider for testability. */
export async function verifyBroadcast({ provider, broadcast, artifacts, environment }) {
  assert(["avalanche-l1", "local-anvil"].includes(environment), "Explicit environment required");
  assert.equal(BigInt(await provider.send("eth_chainId", [])), 20261n, "Wrong chain");
  assert.equal(integer(broadcast.chain), 20261, "Wrong broadcast chain");
  const client = await provider.send("web3_clientVersion", []);
  assert.equal(typeof client, "string");
  if (environment === "local-anvil") assert.match(client, /anvil/i);
  else assert(!/anvil/i.test(client), "Local Anvil cannot be published as L1");
  const readBlock = await provider.send("eth_getBlockByNumber", ["latest", false]);
  assert(readBlock && hash(readBlock.hash) && integer(readBlock.number) > 0, "No confirmed state snapshot");
  assert(Array.isArray(broadcast.transactions) && broadcast.transactions.length === 5, "Expected exactly five deployment/configuration transactions");
  assert(Array.isArray(broadcast.receipts) && broadcast.receipts.length === 5, "Incomplete broadcast receipts");
  assert(Array.isArray(broadcast.pending) && broadcast.pending.length === 0, "Unresolved pending transactions");
  const savedReceipts = new Map(broadcast.receipts.map((receipt) => [hash(receipt.transactionHash), receipt]));
  assert.equal(savedReceipts.size, 5, "Duplicate receipts");
  const seen = new Set();
  const transactions = [];
  const receipts = [];
  let deployer;
  for (let i = 0; i < 5; i++) {
    const claimed = broadcast.transactions[i];
    const txHash = hash(claimed.hash);
    assert(!seen.has(txHash), "Duplicate transaction"); seen.add(txHash);
    const [tx, receipt] = await Promise.all([
      provider.send("eth_getTransactionByHash", [txHash]), provider.send("eth_getTransactionReceipt", [txHash]),
    ]);
    assert(tx && receipt, "Transaction has no confirmed receipt");
    assert.equal(hash(tx.hash), txHash); assert.equal(hash(receipt.transactionHash), txHash);
    assert.equal(BigInt(tx.chainId), 20261n); assert.equal(BigInt(receipt.status), 1n);
    assert.equal(BigInt(tx.value), 0n, "Unexpected value transfer");
    deployer ??= address(tx.from);
    assert(sameAddress(tx.from, deployer) && sameAddress(receipt.from, deployer), "Sender mismatch");
    if (i) assert.equal(BigInt(tx.nonce), BigInt(transactions[i - 1].nonce) + 1n, "Nonsequential deployment nonces");
    const saved = savedReceipts.get(txHash); assert(saved, "Receipt missing from broadcast");
    assert.equal(BigInt(saved.status), 1n);
    assert.equal(hash(receipt.blockHash), hash(saved.blockHash));
    assert.equal(integer(receipt.blockNumber), integer(saved.blockNumber));
    assert.equal(hash(tx.blockHash), hash(receipt.blockHash));
    assert.equal(integer(tx.blockNumber), integer(receipt.blockNumber));
    assert(integer(receipt.blockNumber) <= integer(readBlock.number), "Deployment not included in state snapshot");
    if (i) assert(integer(receipt.blockNumber) >= integer(receipts[i - 1].blockNumber), "Receipt order mismatch");
    const block = await provider.send("eth_getBlockByNumber", [receipt.blockNumber, false]);
    assert(block && hash(block.hash) === hash(receipt.blockHash), "Receipt is not canonical");
    if (i < 3) {
      assert.equal(claimed.transactionType, "CREATE"); assert.equal(claimed.contractName, CONTRACT_NAMES[i]);
      assert.equal(tx.to, null); assert.equal(receipt.to, null); assert.equal(saved.to, null);
      assert(sameAddress(receipt.contractAddress, claimed.contractAddress) && sameAddress(saved.contractAddress, receipt.contractAddress));
      assert(sameAddress(receipt.contractAddress, getCreateAddress({ from: deployer, nonce: tx.nonce })), "Unexpected creation address");
    } else {
      assert.equal(claimed.transactionType, "CALL");
      assert.equal(receipt.contractAddress, null); assert.equal(saved.contractAddress, null);
      assert(sameAddress(tx.to, receipts[1].contractAddress) && sameAddress(receipt.to, tx.to) && sameAddress(saved.to, tx.to));
    }
    transactions.push(tx); receipts.push(receipt);
  }

  const contracts = {};
  const args = {};
  for (let i = 0; i < 3; i++) {
    const name = CONTRACT_NAMES[i]; const artifact = artifacts[name];
    assert(artifact && Array.isArray(artifact.abi) && artifact.abi.length > 0, "Missing current ABI");
    const bytecode = hex(artifact.bytecode.object);
    const input = hex(transactions[i].input);
    assert(bytecode.length > 2 && input.startsWith(bytecode), "Creation bytecode differs from current source");
    const types = artifact.abi.find((entry) => entry.type === "constructor")?.inputs.map((entry) => entry.type) ?? [];
    args[name] = [...coder.decode(types, `0x${input.slice(bytecode.length)}`)].map(address);
    assert.equal(input, `${bytecode}${coder.encode(types, args[name]).slice(2)}`.toLowerCase(), "Noncanonical constructor arguments");
    const contractAddress = address(receipts[i].contractAddress);
    const code = await provider.send("eth_getCode", [contractAddress, readBlock.number]);
    verifyRuntime(code, artifact);
    contracts[name] = { address: contractAddress, abiVersion: 1, abi: artifact.abi, transactionHash: hash(transactions[i].hash),
      blockNumber: integer(receipts[i].blockNumber), blockHash: hash(receipts[i].blockHash), runtimeCodeHash: keccak256(code) };
  }
  const sbt = contracts.StudentSBTIdentity, registry = contracts.CampusPaymentRegistry, vault = contracts.PurposeBoundGrantVault;
  const roles = { deployer, sbtIssuer: args.StudentSBTIdentity[0], posSigner: args.CampusPaymentRegistry[1], grantIssuer: args.PurposeBoundGrantVault[0] };
  assert(sameAddress(args.CampusPaymentRegistry[0], deployer));
  assert(sameAddress(args.CampusPaymentRegistry[2], sbt.address));
  assert(sameAddress(args.PurposeBoundGrantVault[1], registry.address));
  const read = async (contract, method, inputs = []) => {
    const iface = new Interface(contract.abi);
    const result = await provider.send("eth_call", [{ to: contract.address, data: iface.encodeFunctionData(method, inputs) }, readBlock.number]);
    return iface.decodeFunctionResult(method, result)[0];
  };
  for (const [contract, method, expected] of [[sbt, "issuer", roles.sbtIssuer], [registry, "admin", deployer],
    [registry, "posSigner", roles.posSigner], [registry, "studentSbt", sbt.address], [vault, "issuer", roles.grantIssuer],
    [vault, "merchantRegistry", registry.address]]) assert(sameAddress(await read(contract, method), expected), `Role mismatch: ${method}`);
  const iface = new Interface(registry.abi);
  const merchants = {};
  const configurations = [];
  for (const [index, label, category] of [[3, "parking", id("PARKING")], [4, "canteen", id("FOOD")]]) {
    const decoded = iface.parseTransaction({ data: transactions[index].input, value: 0 });
    assert(decoded && decoded.name === "setMerchantCategory" && decoded.args[1] === category && decoded.args[2] === true, "Unexpected allowlist configuration");
    const merchant = address(decoded.args[0]);
    assert.equal(hex(transactions[index].input), iface.encodeFunctionData("setMerchantCategory", [merchant, category, true]).toLowerCase());
    assert(!Object.values(roles).some((role) => sameAddress(role, merchant)), "Merchant is a signing operator");
    assert(!Object.values(contracts).some((contract) => sameAddress(contract.address, merchant)), "Merchant is a contract in this deployment");
    assert.equal(await read(registry, "allowedMerchantCategories", [merchant, category]), true, "Merchant is not currently allowed");
    const event = receipts[index].logs.map((log) => {
      if (!sameAddress(log.address, registry.address)) return null;
      try { return iface.parseLog(log); } catch { return null; }
    }).find((log) => log?.name === "MerchantCategoryUpdated" && sameAddress(log.args[0], merchant)
      && log.args[1] === category && log.args[2] === true);
    assert(event, "Missing expected registry configuration event");
    merchants[label] = { address: merchant, category };
    configurations.push({ transactionHash: hash(transactions[index].hash), blockNumber: integer(receipts[index].blockNumber), blockHash: hash(receipts[index].blockHash) });
  }
  assert(!sameAddress(merchants.parking.address, merchants.canteen.address), "Duplicate merchants");
  // Recheck the chain and canonical blocks after all reads, before publishing the snapshot.
  assert.equal(BigInt(await provider.send("eth_chainId", [])), 20261n);
  for (const receipt of receipts) {
    const block = await provider.send("eth_getBlockByNumber", [receipt.blockNumber, false]);
    assert(block && hash(block.hash) === hash(receipt.blockHash), "Chain changed while exporting");
  }
  const finalReadBlock = await provider.send("eth_getBlockByNumber", [readBlock.number, false]);
  assert(finalReadBlock && hash(finalReadBlock.hash) === hash(readBlock.hash), "Readback snapshot changed");
  return { schemaVersion: 1, status: "deployed", chainId: 20261, abiVersion: 1, environment,
    generatedAt: new Date().toISOString(), verifiedAt: { blockNumber: integer(readBlock.number), blockHash: hash(readBlock.hash) },
    contracts, roles, merchants, configurationTransactions: configurations };
}

async function saveManifest(outputPath, manifest, replace) {
  try {
    const previous = JSON.parse(await readFile(outputPath, "utf8"));
    assert(replace || previous.status !== "deployed", "Refusing to overwrite a deployed manifest without --replace");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(dirname(outputPath), { recursive: true });
  const temp = `${outputPath}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" }); await rename(temp, outputPath); }
  finally { await unlink(temp).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}

export async function exportDeployment({ rpcUrl, broadcastPath, outputPath, contractsDir = join(root, "contracts"), environment, template = false, replace = false }) {
  const artifacts = Object.fromEntries(await Promise.all(CONTRACT_NAMES.map(async (name) => [name, await loadVerifiedArtifact(contractsDir, name)])));
  let manifest;
  if (template) manifest = deploymentTemplate(artifacts);
  else {
    const url = new URL(rpcUrl);
    assert(["http:", "https:"].includes(url.protocol) && !url.username && !url.password, "Invalid RPC URL");
    if (environment === "local-anvil") assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Local evidence requires loopback RPC");
    const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
    try { manifest = await verifyBroadcast({ provider, broadcast: JSON.parse(await readFile(broadcastPath, "utf8")), artifacts, environment }); }
    finally { provider.destroy(); }
  }
  if (outputPath) await saveManifest(resolve(outputPath), manifest, replace);
  return manifest;
}

async function main() {
  const { values } = parseArgs({ options: { broadcast: { type: "string" }, output: { type: "string" }, environment: { type: "string" },
    template: { type: "boolean", default: false }, replace: { type: "boolean", default: false }, help: { type: "boolean" } } });
  if (values.help) { console.log("export-deployment --broadcast <run-latest.json> --environment avalanche-l1|local-anvil [--output deployments/intracampus.json] [--replace]\nOr --template --output <unconfigured.json>. RPC: INTRACAMPUS_RPC_URL. See docs/deployment.md."); return; }
  assert(values.template ? !values.broadcast && !values.environment : values.broadcast && values.environment, "See --help");
  await exportDeployment({ rpcUrl: process.env.INTRACAMPUS_RPC_URL, broadcastPath: values.broadcast,
    outputPath: values.output ?? join(root, "deployments/intracampus.json"), environment: values.environment,
    template: values.template, replace: values.replace });
  console.log("Deployment manifest exported from verified artifacts and configuration.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error("DEPLOYMENT_EXPORT_FAILED: inspect chain, receipts, current build and configuration; no transaction was sent."); process.exitCode = 1;
});
