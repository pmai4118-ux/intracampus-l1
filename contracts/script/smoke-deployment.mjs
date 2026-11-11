// Reproducible L06/B03/L05 evidence on an ephemeral local EVM. Never targets a user RPC.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Contract, JsonRpcProvider, id, keccak256 } from "ethers";
import { loadVerifiedArtifact } from "./load-verified-artifact.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const contractsDir = join(root, "contracts");
const names = ["StudentSBTIdentity", "CampusPaymentRegistry", "PurposeBoundGrantVault"];
const serialize = (value) => JSON.stringify(value, (_, entry) => typeof entry === "bigint" ? entry.toString() : entry, 2) + "\n";
let stage = "load-source-artifacts";

async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
  return port;
}

function publicForgeEnvironment(config, broadcastDir) {
  // No private key or user RPC environment is inherited by the unlocked local-only broadcast.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|systemroot|windir|userprofile|home|homedrive|homepath|temp|tmp|localappdata|appdata|comspec|number_of_processors|processor_architecture)$/i.test(key)));
  return { ...env, ...config, FOUNDRY_BROADCAST: broadcastDir, NO_COLOR: "1" };
}

async function run() {
  const workDir = await mkdtemp(join(tmpdir(), "intracampus-l06-local-"));
  const output = resolve(process.argv[2] ?? join(workDir, "evidence.json"));
  assert.notEqual(output.toLowerCase(), join(root, "deployments/intracampus.json").toLowerCase(), "Local evidence cannot replace the canonical deployment");
  const artifacts = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await loadVerifiedArtifact(contractsDir, name)])));
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn(process.env.ANVIL_BIN ?? "anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "20261", "--silent"],
    { stdio: "ignore", windowsHide: true });
  let spawnError;
  anvil.on("error", (error) => { spawnError = error; });
  const cleanup = () => anvil.kill();
  process.once("exit", cleanup);
  const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 50;
  try {
    let client;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      assert.equal(anvil.exitCode, null, "Local Anvil exited before startup");
      try { client = await provider.send("web3_clientVersion", []); break; } catch { await delay(100); }
    }
    assert.match(client ?? "", /anvil/i, "Local Anvil did not start");
    assert.equal(BigInt(await provider.send("eth_chainId", [])), 20261n);
    const signers = await Promise.all(Array.from({ length: 7 }, (_, index) => provider.getSigner(index)));
    const accounts = await Promise.all(signers.map((signer) => signer.getAddress()));
    const config = {
      DEPLOYER_ADDRESS: accounts[0], SBT_ISSUER_ADDRESS: accounts[0], GRANT_ISSUER_ADDRESS: accounts[0],
      POS_SIGNER_ADDRESS: accounts[1], PARKING_MERCHANT_ADDRESS: accounts[4], CANTEEN_MERCHANT_ADDRESS: accounts[5],
    };
    const broadcastDir = join(workDir, "broadcast");
    stage = "forge-deploy";
    const forge = await exec(process.env.FORGE_BIN ?? "forge", ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", rpcUrl,
      "--unlocked", "--sender", accounts[0], "--broadcast", "--slow", "--timeout", "60", "--rpc-timeout", "10"],
    { cwd: contractsDir, env: publicForgeEnvironment(config, broadcastDir), timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    await writeFile(join(workDir, "forge-deploy.stdout.txt"), forge.stdout);
    const broadcastPath = join(broadcastDir, "Deploy.s.sol", "20261", "run-latest.json");
    stage = "verify-deploy-configuration";
    const broadcast = JSON.parse(await readFile(broadcastPath, "utf8"));
    const created = broadcast.transactions.filter((transaction) => transaction.transactionType === "CREATE");
    assert.deepEqual(created.map((transaction) => transaction.contractName), names, "Deploy order differs from SBT → registry → vault");
    assert.equal(broadcast.receipts.length, 5, "Expected three deployments and two allowlist transactions");
    for (const receipt of broadcast.receipts) assert.equal(BigInt(receipt.status), 1n);
    const addresses = Object.fromEntries(created.map((transaction) => [transaction.contractName, transaction.contractAddress]));
    const sbt = new Contract(addresses.StudentSBTIdentity, artifacts.StudentSBTIdentity.abi, signers[0]);
    const registry = new Contract(addresses.CampusPaymentRegistry, artifacts.CampusPaymentRegistry.abi, signers[0]);
    const vault = new Contract(addresses.PurposeBoundGrantVault, artifacts.PurposeBoundGrantVault.abi, signers[0]);
    assert.equal(await sbt.issuer(), accounts[0]);
    assert.equal(await registry.admin(), accounts[0]);
    assert.equal(await registry.posSigner(), accounts[1]);
    assert.equal((await registry.studentSbt()).toLowerCase(), addresses.StudentSBTIdentity.toLowerCase());
    assert.equal(await vault.issuer(), accounts[0]);
    assert.equal((await vault.merchantRegistry()).toLowerCase(), addresses.CampusPaymentRegistry.toLowerCase());
    assert.equal(await registry.allowedMerchantCategories(accounts[4], id("PARKING")), true);
    assert.equal(await registry.allowedMerchantCategories(accounts[5], id("FOOD")), true);

    // Export while the freshly read-back deployment configuration is still unchanged.
    const manifestPath = join(workDir, "intracampus.local-anvil.json");
    stage = "export-deployment";
    const { exportDeployment } = await import("./export-deployment.mjs");
    const manifest = await exportDeployment({ rpcUrl, broadcastPath, outputPath: manifestPath,
      contractsDir, environment: "local-anvil" });
    assert.equal(manifest.environment, "local-anvil");
    for (const name of names) {
      assert.equal(manifest.contracts[name].address.toLowerCase(), addresses[name].toLowerCase());
      assert.deepEqual(manifest.contracts[name].abi, artifacts[name].abi);
      assert.equal(manifest.contracts[name].runtimeCodeHash, keccak256(await provider.getCode(addresses[name])));
    }

    const { seedDemo, parseSeedConfig, parseDeployment } = await import("../../backend/scripts/seed-demo.ts");
    stage = "seed-two-runs";
    assert.equal(parseDeployment(manifest).address.toLowerCase(), addresses.StudentSBTIdentity.toLowerCase());
    const now = BigInt((await provider.getBlock("latest")).timestamp);
    const normalBalance = await provider.getBalance(accounts[2]);
    const studentBalance = await provider.getBalance(accounts[3]);
    const seedConfig = parseSeedConfig({ schemaVersion: 1, chainId: 20261, funder: accounts[0],
      normal: { address: accounts[2], targetBalanceWei: (normalBalance + 100n * 10n ** 18n).toString() },
      student: { address: accounts[3], targetBalanceWei: (studentBalance + 100n * 10n ** 18n).toString(), expiresAt: (now + 86400n).toString() } });
    const seedEvents = [];
    const submitted = (tx) => ({ hash: tx.hash, wait: async () => {
      const receipt = await tx.wait(1, 60_000);
      return { hash: receipt.hash, status: receipt.status, blockNumber: receipt.blockNumber };
    } });
    const seedClient = {
      sbtAddress: addresses.StudentSBTIdentity,
      chainId: async () => BigInt(await provider.send("eth_chainId", [])),
      timestamp: async () => BigInt((await provider.getBlock("latest")).timestamp),
      issuer: () => sbt.issuer(), codeHash: async () => keccak256(await provider.getCode(addresses.StudentSBTIdentity)),
      balance: (wallet) => provider.getBalance(wallet),
      credential: async (wallet) => {
        const credential = await sbt.credentials(wallet);
        return { tokenId: credential[0], expiresAt: credential[1], tier: Number(await sbt.tierOf(wallet)) };
      },
      assertReady: async (funder, issuer) => {
        assert.equal(funder, accounts[0]); assert.equal(issuer, accounts[0]);
        assert.equal(await provider.getTransactionCount(accounts[0], "pending"), await provider.getTransactionCount(accounts[0], "latest"));
      },
      fund: async (wallet, value) => submitted(await signers[0].sendTransaction({ to: wallet, value })),
      mint: async (wallet, expiresAt) => submitted(await sbt.mint(wallet, expiresAt)),
    };
    const seedOptions = { apply: true, expectedCodeHash: manifest.contracts.StudentSBTIdentity.runtimeCodeHash, emit: (event) => seedEvents.push(event) };
    await seedDemo(seedConfig, seedClient, seedOptions);
    const nonceAfterFirstSeed = await provider.getTransactionCount(accounts[0]);
    const studentToken = (await sbt.credentials(accounts[3]))[0];
    await seedDemo(seedConfig, seedClient, seedOptions);
    assert.equal(await provider.getTransactionCount(accounts[0]), nonceAfterFirstSeed, "Second seed must send no transactions");
    assert.equal((await sbt.credentials(accounts[3]))[0], studentToken, "Second seed must preserve the token");
    assert.equal(seedEvents.filter((event) => event.event === "submitted").length, 3);

    const food = id("FOOD");
    stage = "grant-and-spend";
    const parking = id("PARKING");
    const grantReceipt = await (await vault.grant(accounts[3], food, { value: 5000n * 10n ** 18n })).wait();
    assert.equal(grantReceipt.status, 1);
    const merchantBefore = await provider.getBalance(accounts[5]);
    const spendReceipt = await (await vault.connect(signers[3]).spend(accounts[5], food, 1000n * 10n ** 18n)).wait();
    assert.equal(spendReceipt.status, 1);
    const spentLog = spendReceipt.logs.find((log) => log.address.toLowerCase() === addresses.PurposeBoundGrantVault.toLowerCase()
      && log.topics[0] === vault.interface.getEvent("GrantSpent").topicHash);
    assert(spentLog, "Missing expected vault GrantSpent");
    assert.deepEqual([...vault.interface.parseLog(spentLog).args], [accounts[3], accounts[5], food, 1000n * 10n ** 18n, 4000n * 10n ** 18n]);
    assert.equal(await provider.getBalance(accounts[5]), merchantBefore + 1000n * 10n ** 18n);
    assert.equal(await vault.balances(accounts[3], food), 4000n * 10n ** 18n);
    assert.equal(await vault.totalAllocated(), 4000n * 10n ** 18n);
    assert.equal(await provider.getBalance(addresses.PurposeBoundGrantVault), 4000n * 10n ** 18n);

    const rejections = [];
    stage = "blocked-grant-spends";
    async function expectBlocked(label, merchant, category, amount, errorName) {
      const before = [await vault.balances(accounts[3], food), await vault.totalAllocated(),
        await provider.getBalance(addresses.PurposeBoundGrantVault), await provider.getBalance(merchant)];
      await assert.rejects(vault.connect(signers[3]).spend.staticCall(merchant, category, amount),
        (error) => vault.interface.parseError(error.data)?.name === errorName, label);
      assert.deepEqual([await vault.balances(accounts[3], food), await vault.totalAllocated(),
        await provider.getBalance(addresses.PurposeBoundGrantVault), await provider.getBalance(merchant)], before, `${label} changed state`);
      rejections.push({ label, error: errorName, source: "eth_call simulation; no transaction broadcast" });
    }
    await expectBlocked("personal wallet", accounts[6], food, 1n, "InvalidMerchant");
    await expectBlocked("parking merchant in FOOD", accounts[4], food, 1n, "InvalidMerchant");
    await expectBlocked("canteen in PARKING", accounts[5], parking, 1n, "InvalidMerchant");
    await expectBlocked("cannot switch FOOD budget to allowed PARKING", accounts[4], parking, 1n, "InsufficientGrantBalance");
    await expectBlocked("overspend", accounts[5], food, 4001n * 10n ** 18n, "InsufficientGrantBalance");
    const revokeReceipt = await (await registry.setMerchantCategory(accounts[5], food, false)).wait();
    assert.equal(revokeReceipt.status, 1);
    await expectBlocked("removed canteen", accounts[5], food, 1n, "InvalidMerchant");

    const sourceSha256 = {};
    stage = "write-local-evidence";
    for (const name of names) sourceSha256[`contracts/src/${name}.sol`] = createHash("sha256")
      .update((await readFile(join(contractsDir, "src", `${name}.sol`), "utf8")).replaceAll("\r\n", "\n")).digest("hex");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, serialize({ evidence: "LOCAL ANVIL EVM ONLY; not Avalanche L1 evidence", generatedAt: new Date().toISOString(),
      chainId: 20261, client, sourceHashNormalization: "UTF-8 with LF line endings", sourceSha256,
      manifest, manifestPath, broadcastPath, deployReceipts: broadcast.receipts,
      seed: { events: seedEvents, secondRunTransactions: 0, tokenPreserved: true },
      grant: { issuedReceipt: grantReceipt.toJSON(), spentReceipt: spendReceipt.toJSON(), remainingWei: "4000000000000000000000",
        revokedMerchantReceipt: revokeReceipt.toJSON(), rejections },
      note: "Manifest describes the fresh configuration before the test deliberately removes the canteen allowlist. The ephemeral node is stopped after this run." }), { flag: "wx" });
    console.log(`L06 local EVM: Forge deploy/export, B03 seed twice and L05 grant restrictions passed.\nEvidence: ${output}`);
  } finally {
    provider.destroy();
    cleanup();
    process.removeListener("exit", cleanup);
  }
}

run().catch((error) => {
  if (process.env.L06_DEBUG === "1") console.error(error);
  console.error(`L06_LOCAL_SMOKE_FAILED at ${stage}: inspect local source, tools and evidence directory; no L1 deployment was attempted.`);
  process.exitCode = 1;
});
