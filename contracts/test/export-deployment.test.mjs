// Synthetic RPC cases exercise publication gates; actual Forge/Anvil receipts are covered by smoke:l06.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbiCoder, Interface, getCreateAddress, id, keccak256, toUtf8Bytes } from "ethers";
import manifest from "../../deployments/intracampus.json" with { type: "json" };
import { CONTRACT_NAMES, deploymentTemplate, exportDeployment, verifyBroadcast, verifyRuntime } from "../script/export-deployment.mjs";

const addr = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const coder = AbiCoder.defaultAbiCoder();
function fixture() {
  const deployer = addr(10), signer = addr(11), issuer = addr(12);
  const addresses = CONTRACT_NAMES.map((_, nonce) => getCreateAddress({ from: deployer, nonce }));
  const args = [[issuer], [deployer, signer, addresses[0]], [issuer, addresses[1]]];
  const artifacts = Object.fromEntries(CONTRACT_NAMES.map((name, i) => [name, {
    abi: manifest.contracts[name].abi, bytecode: { object: `0x600${i}` },
    deployedBytecode: { object: `0x601${i}`, immutableReferences: {} },
  }]));
  const txs = [], receipts = [], claims = [];
  for (let i = 0; i < 5; i++) {
    const creation = i < 3;
    const iface = new Interface(artifacts.CampusPaymentRegistry.abi);
    const input = creation
      ? artifacts[CONTRACT_NAMES[i]].bytecode.object + coder.encode(args[i].map(() => "address"), args[i]).slice(2)
      : iface.encodeFunctionData("setMerchantCategory", [addr(i === 3 ? 20 : 21), id(i === 3 ? "PARKING" : "FOOD"), true]);
    txs.push({ hash: hash(i + 1), from: deployer, to: creation ? null : addresses[1], nonce: `0x${i}`,
      chainId: "0x4f25", value: "0x0", input, blockNumber: `0x${i + 1}`, blockHash: hash(100 + i) });
    const event = creation ? null : iface.encodeEventLog(iface.getEvent("MerchantCategoryUpdated"), [addr(i === 3 ? 20 : 21), id(i === 3 ? "PARKING" : "FOOD"), true]);
    receipts.push({ transactionHash: hash(i + 1), status: "0x1", from: deployer, to: txs[i].to,
      contractAddress: creation ? addresses[i] : null, blockNumber: txs[i].blockNumber, blockHash: txs[i].blockHash,
      logs: event ? [{ address: addresses[1], ...event }] : [] });
    claims.push({ hash: txs[i].hash, transactionType: creation ? "CREATE" : "CALL",
      contractName: creation ? CONTRACT_NAMES[i] : "CampusPaymentRegistry", contractAddress: creation ? addresses[i] : addresses[1] });
  }
  const state = { chain: "0x4f25", client: "anvil/v1.7.1", canonical: true, roleOverride: null, codeOverride: null, allowlisted: true, missing: false };
  const broadcast = { chain: 20261, pending: [], transactions: claims, receipts: structuredClone(receipts) };
  const provider = { send: async (method, params) => {
    if (method === "eth_chainId") return state.chain;
    if (method === "web3_clientVersion") return state.client;
    if (method === "eth_getTransactionByHash") return txs.find((tx) => tx.hash === params[0]);
    if (method === "eth_getTransactionReceipt") return state.missing ? null : receipts.find((receipt) => receipt.transactionHash === params[0]);
    if (method === "eth_getBlockByNumber") {
      const number = params[0] === "latest" ? "0x5" : params[0];
      return { number, hash: state.canonical ? receipts.find((receipt) => receipt.blockNumber === number).blockHash : hash(999) };
    }
    if (method === "eth_getCode") return state.codeOverride ?? artifacts[CONTRACT_NAMES[addresses.findIndex((address) => address.toLowerCase() === params[0].toLowerCase())]].deployedBytecode.object;
    if (method === "eth_call") {
      const index = addresses.findIndex((address) => address.toLowerCase() === params[0].to.toLowerCase());
      const iface = new Interface(artifacts[CONTRACT_NAMES[index]].abi);
      const decoded = iface.parseTransaction({ data: params[0].data });
      const values = [{ issuer }, { admin: deployer, posSigner: signer, studentSbt: addresses[0], allowedMerchantCategories: state.allowlisted }, { issuer, merchantRegistry: addresses[1] }];
      return iface.encodeFunctionResult(decoded.name, [state.roleOverride && decoded.name === "issuer" ? state.roleOverride : values[index][decoded.name]]);
    }
    throw new Error(`Unexpected test RPC ${method}`);
  } };
  return { provider, broadcast, artifacts, environment: "local-anvil", state, txs, receipts };
}

test("verified complete deployment exports exact ABI, blocks, hashes and roles without RPC secrets", async () => {
  const f = fixture(); const actual = await verifyBroadcast(f);
  assert.equal(actual.status, "deployed"); assert.equal(actual.chainId, 20261); assert.equal(actual.environment, "local-anvil");
  assert.equal(actual.configurationTransactions.length, 2);
  for (const name of CONTRACT_NAMES) {
    assert.deepEqual(actual.contracts[name].abi, manifest.contracts[name].abi);
    assert.equal(actual.contracts[name].runtimeCodeHash, keccak256(f.artifacts[name].deployedBytecode.object));
  }
  assert.equal(actual.roles.deployer.toLowerCase(), addr(10)); assert.equal(actual.merchants.canteen.category, id("FOOD"));
  assert(!JSON.stringify(actual).includes("http"));
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
  ["wrong sender", (f) => { f.txs[1].from = addr(99); }],
  ["wrong transaction chain", (f) => { f.txs[1].chainId = "0x1"; }],
  ["unexpected money transfer", (f) => { f.txs[1].value = "0x1"; }],
  ["wrong deployment order", (f) => { f.broadcast.transactions[0].contractName = CONTRACT_NAMES[1]; }],
  ["creation with to", (f) => { f.txs[0].to = addr(99); }],
  ["wrong creation address", (f) => { f.receipts[0].contractAddress = addr(99); }],
  ["wrong creation bytecode", (f) => { f.txs[0].input = "0x60ff" + f.txs[0].input.slice(6); }],
  ["trailing constructor bytes", (f) => { f.txs[0].input += "00"; }],
  ["wrong runtime", (f) => { f.state.codeOverride = "0x60ff"; }],
  ["wrong immutable role", (f) => { f.state.roleOverride = addr(99); }],
  ["nonsequential nonce", (f) => { f.txs[4].nonce = "0x9"; }],
  ["configuration at wrong contract", (f) => { f.txs[3].to = addr(99); }],
  ["missing allowlist event", (f) => { f.receipts[3].logs = []; }],
  ["merchant currently disabled", (f) => { f.state.allowlisted = false; }],
  ["wrong category", (f) => { f.txs[4].input = new Interface(f.artifacts.CampusPaymentRegistry.abi).encodeFunctionData("setMerchantCategory", [addr(21), id("PARKING"), true]); }],
  ["operator as merchant", (f) => { f.txs[4].input = new Interface(f.artifacts.CampusPaymentRegistry.abi).encodeFunctionData("setMerchantCategory", [addr(10), id("FOOD"), true]); }],
]) test(`export refuses ${label}`, async () => { const f = fixture(); change(f); await assert.rejects(verifyBroadcast(f)); });

test("Anvil cannot be relabeled as Avalanche L1", async () => { const f = fixture(); f.environment = "avalanche-l1"; await assert.rejects(verifyBroadcast(f)); });
test("production client is recorded only with an explicit production environment", async () => {
  const f = fixture(); f.environment = "avalanche-l1"; f.state.client = "Subnet-EVM/test";
  assert.equal((await verifyBroadcast(f)).environment, "avalanche-l1");
});
test("immutable code matching ignores only compiler-declared zero slots", () => {
  const artifact = { deployedBytecode: { object: "0x60000000ff", immutableReferences: { 1: [{ start: 1, length: 3 }] } } };
  verifyRuntime("0x60aabbccff", artifact);
  assert.throws(() => verifyRuntime("0x61aabbccff", artifact));
  assert.throws(() => verifyRuntime("0x60aabbccfe", artifact));
  assert.throws(() => verifyRuntime("0x60aabbcc", artifact));
});
test("template includes ABI but no invented transaction evidence", () => {
  const value = deploymentTemplate(fixture().artifacts);
  assert.equal(value.status, "unconfigured"); assert.equal(value.roles, null);
  for (const contract of Object.values(value.contracts)) assert.equal(contract.address, null);
});
test("template export verifies source freshness and preserves an existing deployment", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "l06-export-test-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const artifacts = fixture().artifacts;
  for (const name of CONTRACT_NAMES) {
    const source = `// Synthetic test artifact ${name}`;
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "out", `${name}.sol`), { recursive: true });
    await writeFile(join(dir, "src", `${name}.sol`), source);
    await writeFile(join(dir, "out", `${name}.sol`, `${name}.json`), JSON.stringify({ ...artifacts[name], metadata: { sources: {
      [`src/${name}.sol`]: { keccak256: keccak256(toUtf8Bytes(source)) },
    } } }));
  }
  const outputPath = join(dir, "deployment.json");
  const result = await exportDeployment({ contractsDir: dir, outputPath, template: true });
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), result);
  await writeFile(outputPath, '{"status":"deployed"}');
  await assert.rejects(exportDeployment({ contractsDir: dir, outputPath, template: true }), /overwrite/);
  assert.equal(await readFile(outputPath, "utf8"), '{"status":"deployed"}');
  await writeFile(join(dir, "src", "StudentSBTIdentity.sol"), "changed after build");
  await assert.rejects(exportDeployment({ contractsDir: dir, outputPath, template: true, replace: true }), /stale/);
  assert.equal(await readFile(outputPath, "utf8"), '{"status":"deployed"}');
});
