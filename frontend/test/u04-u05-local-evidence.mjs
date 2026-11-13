// Real local EVM + B01/B02/B05 HTTP + U04/U05 controllers. Never connects to a user RPC.
// Usage (Node 24, after pnpm install and forge build):
// node frontend/test/u04-u05-local-evidence.mjs <new-evidence.json>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Contract, ContractFactory, Interface, JsonRpcProvider, Wallet, id, keccak256 } from "ethers";

const root = fileURLToPath(new URL("../../", import.meta.url));
const contractsDir = join(root, "contracts");
const unit = 10n ** 18n;
let stage = "check-prerequisites";
const importSource = (path) => import(pathToFileURL(join(root, path)).href);

async function freePort() {
  const listener = createServer().listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done, fail) => listener.close((error) => error ? fail(error) : done()));
  return port;
}
const memoryStorage = () => {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
};
function localEnvironment() {
  // Do not pass operator keys, RPC URLs or application configuration to the child node.
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|systemroot|windir|temp|tmp|localappdata|appdata|comspec|number_of_processors|processor_architecture)$/i.test(key)));
}

async function main() {
  const outputArgument = process.argv[2];
  if (!outputArgument || process.argv.length !== 3) throw Error("USAGE");
  const output = resolve(outputArgument);
  // Optional test-only lifecycle for the Python browser proof. Never used by the app.
  const browserDirectory = process.env.U05_BROWSER_FIXTURE_DIR ? resolve(process.env.U05_BROWSER_FIXTURE_DIR) : null;
  if (browserDirectory && !browserDirectory.toLowerCase().startsWith((join(root, "backend", "data") + sep).toLowerCase())) {
    throw Error("BROWSER_DIRECTORY");
  }
  if (output.toLowerCase() === join(root, "deployments/intracampus.json").toLowerCase()) throw Error("CANONICAL_OUTPUT");
  try { await access(output); throw Error("OUTPUT_EXISTS"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  try { await access(join(root, "backend/src/modules/grants/grants.service.ts")); }
  catch { throw Error("B05_MISSING"); }
  const { loadVerifiedArtifact } = await importSource("contracts/script/load-verified-artifact.mjs");
  const { InvoiceCreationService } = await importSource("backend/src/modules/invoices/invoices.service.ts");
  const { SqliteInvoiceRepository } = await importSource("backend/src/modules/invoices/invoices.repository.ts");
  const { HttpInvoiceRpc } = await importSource("backend/src/modules/invoices/invoices.rpc.ts");
  const { ReceiptService } = await importSource("backend/src/modules/invoices/receipt.service.ts");
  const { GrantsService } = await importSource("backend/src/modules/grants/grants.service.ts");
  const { createApp } = await importSource("backend/src/app.ts");
  const { verifyInvoicePreview, encodePayInvoiceSimulation, encodeInvoiceQuoteCall } = await importSource("frontend/lib/invoice.ts");
  const { WalletController } = await importSource("frontend/lib/wallet.ts");
  const { PaymentController } = await importSource("frontend/lib/payment.ts");
  const { GrantController, encodeGrantSpend, preflightGrant } = await importSource("frontend/lib/grants.ts");
  stage = "verify-current-artifacts-run-forge-build-if-stale";
  const names = ["StudentSBTIdentity", "CampusPaymentRegistry", "PurposeBoundGrantVault"];
  const artifacts = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await loadVerifiedArtifact(contractsDir, name)])));
  const directory = await mkdtemp(join(tmpdir(), "intracampus-u04-u05-"));
  const port = await freePort(), rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn(process.env.ANVIL_BIN ?? "anvil", ["--host", "127.0.0.1", "--port", String(port),
    "--chain-id", "20261", "--balance", "100000", "--silent"], { stdio: "ignore", windowsHide: true, env: localEnvironment() });
  let spawnError; anvil.on("error", (error) => { spawnError = error; });
  const killAnvil = () => { anvil.kill(); }; process.once("exit", killAnvil);
  const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 50;
  let server, repository, grants, finishBrowser;
  const sessions = [], fetchOriginal = globalThis.fetch;
  const evidence = { environment: "local-anvil", chainId: 20261,
    scope: "Ephemeral Anvil, actual source-verified contracts and HTTP services, injected EIP-1193 adapter. Not Core, physical-device or Avalanche L1 acceptance.",
    selectors: {}, cases: [] };
  try {
    stage = "start-loopback-anvil";
    for (let attempt = 0; ; attempt++) {
      if (spawnError) throw spawnError;
      try { assert.match(String(await provider.send("web3_clientVersion", [])), /anvil/i); break; }
      catch (error) { if (attempt === 60) throw error; await delay(100); }
    }
    assert.equal(BigInt(await provider.send("eth_chainId", [])), 20261n);
    const signers = await Promise.all(Array.from({ length: 8 }, (_, index) => provider.getSigner(index)));
    const accounts = await Promise.all(signers.map((signer) => signer.getAddress()));
    // Random signing key exists only in memory and can authorize invoices only on this temporary chain.
    const pos = Wallet.createRandom(), contracts = {}, deployed = {};
    const roles = { deployer: accounts[0], sbtIssuer: accounts[0], grantIssuer: accounts[0], posSigner: pos.address };
    stage = "deploy-real-contracts";
    for (const name of names) {
      const artifact = artifacts[name];
      const args = name === "StudentSBTIdentity" ? [roles.sbtIssuer] : name === "CampusPaymentRegistry"
        ? [roles.deployer, roles.posSigner, deployed.StudentSBTIdentity.address]
        : [roles.grantIssuer, deployed.CampusPaymentRegistry.address];
      const instance = await new ContractFactory(artifact.abi, artifact.bytecode.object, signers[0]).deploy(...args);
      const receipt = await instance.deploymentTransaction().wait(); assert.equal(receipt.status, 1);
      const address = await instance.getAddress(); contracts[name] = new Contract(address, artifact.abi, signers[0]);
      deployed[name] = { address, abiVersion: 1, abi: artifact.abi, transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, runtimeCodeHash: keccak256(await provider.getCode(address)) };
    }
    const merchants = { parking: { address: accounts[4], category: id("PARKING") }, canteen: { address: accounts[5], category: id("FOOD") } };
    for (const merchant of Object.values(merchants)) await (await contracts.CampusPaymentRegistry.setMerchantCategory(merchant.address, merchant.category, true)).wait();
    await (await contracts.StudentSBTIdentity.mint(accounts[3], BigInt((await provider.getBlock("latest")).timestamp) + 7n * 86400n)).wait();
    await (await contracts.PurposeBoundGrantVault.grant(accounts[3], id("FOOD"), { value: 5000n * unit })).wait();
    const manifest = { schemaVersion: 1, status: "deployed", chainId: 20261, abiVersion: 1, environment: "local-anvil", contracts: deployed, roles, merchants };
    const rpc = (method, params) => provider.send(method, params);
    const invoiceRpc = new HttpInvoiceRpc(rpcUrl), deployment = { contractAddress: deployed.CampusPaymentRegistry.address,
      deploymentBlock: deployed.CampusPaymentRegistry.blockNumber };
    repository = new SqliteInvoiceRepository(join(directory, "invoices.sqlite"));
    const creation = new InvoiceCreationService({ repository, rpc: invoiceRpc, deployment,
      config: { merchant: merchants.parking.address, privateKey: pos.privateKey, expectedSigner: pos.address, studentSbt: deployed.StudentSBTIdentity.address } });
    const receipts = new ReceiptService({ repository, rpc: invoiceRpc, deployment });
    grants = new GrantsService({ rpcUrl, deployment: manifest, allowLocal: true, provider });
    const app = createApp(rpcUrl, receipts, creation, grants);
    if (browserDirectory) app.post("/__u05-fixture/stop", (_req, res) => { res.sendStatus(204); finishBrowser?.(); });
    server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const api = `http://127.0.0.1:${server.address().port}`;
    globalThis.fetch = (url, options) => fetchOriginal(typeof url === "string" && url.startsWith("/") ? api + url : url, options);
    const trusted = { paymentRegistryAddress: deployed.CampusPaymentRegistry.address, posSignerAddress: roles.posSigner };
    async function post() {
      const response = await fetch(`${api}/api/invoices`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchantId: "parking-demo", serviceId: "parking-single" }) });
      assert.equal(response.status, 201); return response.json();
    }
    async function wallet(account, mode = {}) {
      const counts = { sends: 0, hashes: [] };
      const session = new WalletController({ config: { rpcUrl, sbtAddress: deployed.StudentSBTIdentity.address }, rpc,
        provider: { on() {}, removeListener() {}, async request({ method, params }) {
          if (method === "eth_accounts") return [account];
          if (method === "eth_sendTransaction") {
            counts.sends++;
            if (mode.reject) throw { code: 4001 };
            const hash = await provider.send(method, params); counts.hashes.push(hash);
            if (mode.unknown) throw new TypeError("Injected disconnect after local broadcast");
            return hash;
          }
          return provider.send(method, params ?? []);
        } } });
      sessions.push(session); await session.start(); assert.equal(session.getSnapshot().canProceed, true); return { session, counts };
    }
    function payment(preview, account, session, journal = memoryStorage()) {
      const controller = new PaymentController({ preview, account, storage: journal, wallet: session,
        preflight: (payload, payer, signal) => verifyInvoicePreview(payload, payer, trusted, rpc, signal) });
      sessions.push(controller); return { controller, journal };
    }
    const registryInterface = new Interface(artifacts.CampusPaymentRegistry.abi), vaultInterface = new Interface(artifacts.PurposeBoundGrantVault.abi);
    evidence.selectors = { payInvoice: registryInterface.getFunction("payInvoice").selector, spend: vaultInterface.getFunction("spend").selector };
    assert.equal(evidence.selectors.payInvoice, "0xba5e2a9e"); assert.equal(evidence.selectors.spend, "0xe2f7cbfa");
    for (const [label, account, expectedAmount] of [["normal", accounts[2], 3000n], ["student", accounts[3], 2700n]]) {
      stage = `pay-${label}-and-restore`;
      const { envelope } = await post(), preview = await verifyInvoicePreview(JSON.stringify(envelope), account, trusted, rpc);
      const tuple = [envelope.invoice.invoiceId, envelope.invoice.merchant, envelope.invoice.category, envelope.invoice.amount, envelope.invoice.expiresAt];
      assert.equal(encodePayInvoiceSimulation(envelope), registryInterface.encodeFunctionData("payInvoice", [tuple, envelope.signature]));
      assert.equal(encodeInvoiceQuoteCall(envelope, account), registryInterface.encodeFunctionData("quoteInvoice", [tuple, account]));
      assert.equal(preview.quote.paidAmount, expectedAmount * unit);
      const { session, counts } = await wallet(account), { controller, journal } = payment(preview, account, session);
      await Promise.all([controller.pay(), controller.pay()]);
      for (let n = 0; controller.getSnapshot().status === "pending" && n < 5; n++) await controller.refresh();
      const state = controller.getSnapshot(); assert.equal(state.status, "paid");
      assert.equal(state.receipt.payer.toLowerCase(), account.toLowerCase()); assert.equal(BigInt(state.receipt.paidAmount), expectedAmount * unit);
      assert.equal(counts.sends, 1); await controller.pay(); assert.equal(counts.sends, 1);
      const restored = payment(preview, account, session, journal).controller;
      await restored.refresh(); assert.equal(restored.getSnapshot().status, "paid"); await restored.pay(); assert.equal(counts.sends, 1);
      evidence.cases.push({ name: `${label}: real B01 invoice → frontend preflight/send → B02 receipt → journal reload`,
        invoiceId: envelope.invoice.invoiceId, txHash: state.txHash, payer: state.receipt.payer, paidAmountWei: state.receipt.paidAmount,
        discountAmountWei: state.receipt.discountAmount, sendCount: counts.sends });
    }
    stage = "wallet-rejection";
    {
      const { envelope } = await post(), account = accounts[3], preview = await verifyInvoicePreview(JSON.stringify(envelope), account, trusted, rpc);
      const { session, counts } = await wallet(account, { reject: true }), { controller } = payment(preview, account, session);
      await controller.pay(); assert.equal(controller.getSnapshot().canPay, true); assert.equal(controller.getSnapshot().txHash, null);
      assert.equal(await contracts.CampusPaymentRegistry.isInvoicePaid(envelope.invoice.invoiceId), false);
      evidence.cases.push({ name: "EIP-1193 rejection4001: no on-chain payment; retry requires fresh preflight", requests: counts.sends });
    }
    stage = "broadcast-disconnect-and-recover";
    {
      const { envelope } = await post(), account = accounts[3], preview = await verifyInvoicePreview(JSON.stringify(envelope), account, trusted, rpc);
      const { session, counts } = await wallet(account, { unknown: true }), { controller, journal } = payment(preview, account, session);
      await controller.pay(); assert.equal(controller.getSnapshot().status, "unknown"); assert.equal(controller.getSnapshot().canPay, false);
      const restored = payment(preview, account, session, journal).controller;
      await restored.pay(); assert.equal(counts.sends, 1); await restored.refresh();
      assert.equal(restored.getSnapshot().status, "paid"); assert.equal(restored.getSnapshot().txHash, counts.hashes[0]);
      evidence.cases.push({ name: "disconnect after actual broadcast: restored unknown intent recovers receipt without resend", txHash: counts.hashes[0], sendCount: counts.sends });
    }
    stage = "grant-spend-and-restore";
    const before = await (await fetch(`${api}/api/grants/${accounts[3]}`)).json(); assert.equal(before.balanceWei, String(5000n * unit));
    // Explicit fixture injection. Production grantConfig continues to reject local manifests.
    const config = { vault: deployed.PurposeBoundGrantVault.address, registry: deployed.CampusPaymentRegistry.address, issuer: roles.grantIssuer,
      merchant: merchants.canteen.address, category: merchants.canteen.category, deploymentHash: deployed.PurposeBoundGrantVault.transactionHash };
    assert.equal(encodeGrantSpend(config, 1000n * unit), vaultInterface.encodeFunctionData("spend", [config.merchant, config.category, 1000n * unit]));
    const grantWallet = await wallet(accounts[3]), journal = memoryStorage(), lock = async (_key, run) => run();
    const grant = new GrantController({ config, rpc, wallet: grantWallet.session, storage: journal, lock }); sessions.push(grant);
    await grant.bindWallet(accounts[3]); assert.equal(grant.getSnapshot().lookup.balanceWei, String(5000n * unit));
    await Promise.all([grant.spend(1000n * unit), grant.spend(1000n * unit)]);
    for (let n = 0; grant.getSnapshot().phase === "pending" && n < 5; n++) await grant.refresh();
    assert.equal(grant.getSnapshot().phase, "confirmed"); assert.equal(grantWallet.counts.sends, 1);
    const grantHash = grant.getSnapshot().intent.hash, after = await (await fetch(`${api}/api/grants/${accounts[3]}?txHash=${grantHash}`)).json();
    assert.equal(after.balanceWei, String(4000n * unit)); assert.equal(after.transaction.status, "verified");
    const event = after.transaction.events.find((entry) => entry.event === "GrantSpent");
    assert.equal(event.beneficiary.toLowerCase(), accounts[3].toLowerCase()); assert.equal(event.merchant.toLowerCase(), config.merchant.toLowerCase());
    assert.equal(event.amountWei, String(1000n * unit));
    evidence.cases.push({ name: "frontend grant spend + B05 HTTP verifies GrantSpent and balance", beforeWei: before.balanceWei,
      afterWei: after.balanceWei, transactionHash: grantHash, event, sendCount: grantWallet.counts.sends });
    const restoredGrant = new GrantController({ config, rpc, wallet: grantWallet.session, storage: journal, lock }); sessions.push(restoredGrant);
    await restoredGrant.bindWallet(accounts[3]); assert.equal(restoredGrant.getSnapshot().phase, "confirmed");
    await restoredGrant.spend(1000n * unit); assert.equal(grantWallet.counts.sends, 1);
    for (const [name, badConfig, amount] of [["personal wallet", { ...config, merchant: accounts[6] }, 1000n * unit],
      ["wrong category", { ...config, category: id("PARKING") }, 1000n * unit], ["over balance", config, 5000n * unit]]) {
      stage = `block-grant-${name}`;
      let code; try { await preflightGrant(rpc, badConfig, accounts[3], amount); } catch (error) { code = error.code; }
      assert.ok(code); assert.equal(await contracts.PurposeBoundGrantVault.balances(accounts[3], id("FOOD")), 4000n * unit);
      evidence.cases.push({ name: `grant preflight blocks ${name}; voucher remains4000`, code });
    }
    stage = "save-public-evidence";
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
    process.stdout.write(`${evidence.cases.length} local EVM/controller scenarios passed; public evidence written to the requested file.\n`);
    if (browserDirectory) {
      stage = "prepare-isolated-browser-fixture";
      // A separate local account keeps the eight controller cases and their receipts intact.
      const beneficiary = accounts[7];
      await (await contracts.StudentSBTIdentity.mint(beneficiary, BigInt((await provider.getBlock("latest")).timestamp) + 7n * 86400n)).wait();
      await (await contracts.PurposeBoundGrantVault.grant(beneficiary, id("FOOD"), { value: 5000n * unit })).wait();
      const publicConfig = { environment: "local-anvil", chainId: 20261, api, rpcUrl, beneficiary, preparedBeneficiary: accounts[3], normalAccount: accounts[2], admin: accounts[0],
        vault: deployed.PurposeBoundGrantVault.address, registry: deployed.CampusPaymentRegistry.address, canteen: merchants.canteen.address,
        disableCanteen: registryInterface.encodeFunctionData("setMerchantCategory", [merchants.canteen.address, merchants.canteen.category, false]),
        enableCanteen: registryInterface.encodeFunctionData("setMerchantCategory", [merchants.canteen.address, merchants.canteen.category, true]), manifest,
        scope: "Test fixture only. UI uses a synthetic deployment in an ignored source copy; canonical manifest and operator environment are untouched." };
      await mkdir(browserDirectory, { recursive: true });
      const waitForBrowser = new Promise((done) => { finishBrowser = done; });
      await writeFile(join(browserDirectory, "public-config.json"), JSON.stringify(publicConfig, null, 2) + "\n", { flag: "wx" });
      process.stdout.write("Isolated browser fixture ready. POST /__u05-fixture/stop to close its loopback resources.\n");
      await waitForBrowser;
    }
  } finally {
    globalThis.fetch = fetchOriginal;
    for (const session of sessions) session.dispose();
    if (server) await new Promise((done) => server.close(done));
    repository?.close(); grants?.close(); provider.destroy(); anvil.kill(); process.removeListener("exit", killAnvil);
  }
}
try { await main(); }
catch (error) {
  const messages = { USAGE: "Usage: node frontend/test/u04-u05-local-evidence.mjs <new-evidence.json>",
    OUTPUT_EXISTS: "Output already exists. Choose a new evidence filename; existing evidence is preserved.",
    CANONICAL_OUTPUT: "Local evidence cannot replace deployments/intracampus.json.",
    BROWSER_DIRECTORY: "Browser fixtures must stay inside ignored backend/data; the canonical deployment is never replaced.",
    B05_MISSING: "B05 API source is missing. Integrate/review B05 PR #16 together with U04/U05 before running this local acceptance script." };
  process.stderr.write((messages[error.message] ?? `Local acceptance failed at ${stage}. Check Node24/pnpm dependencies, Anvil and current artifacts (forge build --force).`) + "\n");
  process.exitCode = 1;
}
