// Actual EVM contracts on an explicitly local Anvil; never a public/user RPC.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ContractFactory, JsonRpcProvider, Wallet, id } from "ethers";
import { createApp } from "../src/app.ts";
import { InvoiceCreationService } from "../src/modules/invoices/invoices.service.ts";
import { SqliteInvoiceRepository } from "../src/modules/invoices/invoices.repository.ts";
import { HttpInvoiceRpc, InvoiceRpcError } from "../src/modules/invoices/invoices.rpc.ts";
import { ReceiptService } from "../src/modules/invoices/receipt.service.ts";

const output = process.argv[2]; assert.ok(output, "Usage: node test/b04-local-evidence.ts <output.json>");
const url = "http://127.0.0.1:18547";
const provider = new JsonRpcProvider(url, 20261, { staticNetwork: true, cacheTimeout: -1 }); provider.pollingInterval = 50;
const dir = mkdtempSync(join(tmpdir(), "b04-evm-")), path = join(dir, "invoices.sqlite");
let repository = new SqliteInvoiceRepository(path), server: Server | undefined;
const stop = async () => { if (server) await new Promise<void>((done, fail) => server!.close((error) => error ? fail(error) : done())); server = undefined; };
class SwitchableRpc extends HttpInvoiceRpc {
  available = true;
  override call(method: string, params: unknown[]) { if (!this.available) return Promise.reject(new InvoiceRpcError()); return super.call(method, params); }
}
try {
  assert.match(await provider.send("web3_clientVersion", []), /anvil/i);
  assert.equal(BigInt(await provider.send("eth_chainId", [])), 20261n);
  const contractsRoot = fileURLToPath(new URL("../../contracts", import.meta.url));
  const { loadVerifiedArtifact } = await import(pathToFileURL(join(contractsRoot, "script/load-verified-artifact.mjs")).href);
  const [identityArtifact, paymentArtifact] = await Promise.all([
    loadVerifiedArtifact(contractsRoot, "StudentSBTIdentity"), loadVerifiedArtifact(contractsRoot, "CampusPaymentRegistry")]);
  const admin = await provider.getSigner(0), merchant = await provider.getSigner(1);
  const wallet = Wallet.fromPhrase("test test test test test test test test test test test junk");
  assert.equal(await admin.getAddress(), wallet.address);
  const identity = await new ContractFactory(identityArtifact.abi, identityArtifact.bytecode.object, admin).deploy(wallet.address);
  await identity.waitForDeployment();
  const payment = await new ContractFactory(paymentArtifact.abi, paymentArtifact.bytecode.object, admin).deploy(wallet.address, wallet.address, await identity.getAddress());
  await payment.waitForDeployment();
  const contractAddress = await payment.getAddress(), merchantAddress = await merchant.getAddress();
  await (await payment.getFunction("setMerchantCategory")(merchantAddress, id("PARKING"), true)).wait();
  const deployment = { contractAddress, deploymentBlock: (await payment.deploymentTransaction()!.wait())!.blockNumber };
  const rpc = new SwitchableRpc(url); let clock = Date.now(); const logs: Record<string, unknown>[] = [];
  async function start() {
    const receipts = new ReceiptService({ repository, rpc, deployment, now: () => clock, log: (entry) => logs.push(entry) });
    const creation = new InvoiceCreationService({ repository, rpc, deployment, config: { merchant: merchantAddress,
      privateKey: wallet.privateKey, expectedSigner: wallet.address, studentSbt: await identity.getAddress() } });
    server = createServer(createApp(url, receipts, creation)).listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string"); return `http://127.0.0.1:${address.port}`;
  }
  let api = await start(); const cases: unknown[] = [];
  for (const tier of [0, 1]) {
    const payer = await provider.getSigner(tier + 2), payerAddress = await payer.getAddress();
    if (tier) await (await identity.getFunction("mint")(payerAddress, Math.floor(Date.now() / 1000) + 3600)).wait();
    const createdResponse = await fetch(`${api}/api/invoices`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId: "parking-demo", serviceId: "parking-single" }) });
    assert.equal(createdResponse.status, 201); const created = await createdResponse.json(), e = created.envelope;
    const amount = BigInt(e.invoice.amount), discount = tier ? amount / 10n : 0n;
    const tx = await payment.connect(payer).getFunction("payInvoice")(
      [e.invoice.invoiceId, e.invoice.merchant, e.invoice.category, e.invoice.amount, e.invoice.expiresAt], e.signature, { value: amount - discount });
    const raw = await tx.wait(); assert.equal(raw.status, 1);
    rpc.available = false;
    const unavailable = await fetch(`${api}/api/invoices/${created.invoiceId}?txHash=${tx.hash}`);
    assert.equal(unavailable.status, 503); const outage = await unavailable.json();
    assert.equal(outage.transaction.txHash, tx.hash); assert.equal(outage.receipt, null);
    rpc.available = true; clock += 31000;
    const paidResponse = await fetch(`${api}/api/invoices/${created.invoiceId}`), paid = await paidResponse.json();
    assert.equal(paid.status, "paid"); assert.equal(paid.receipt.tier, tier); assert.equal(paid.receipt.paidAmount, (amount - discount).toString());
    assert.equal(paid.receipt.txHash, tx.hash); assert.equal(paid.receipt.invoiceId, e.invoice.invoiceId);
    await stop(); repository.close(); repository = new SqliteInvoiceRepository(path); rpc.available = false; api = await start();
    const restoredResponse = await fetch(`${api}/api/invoices/${created.invoiceId}`); assert.equal(restoredResponse.status, 200);
    assert.deepEqual(await restoredResponse.json(), paid); rpc.available = true;
    cases.push({ tier, envelope: e, txHash: tx.hash, rawReceipt: raw.toJSON(), verifiedReceipt: paid.receipt,
      rpcOutagePreservedHash: true, sqliteReopenPaidWithRpcOffline: true });
  }
  assert.equal(logs.filter((entry) => entry.event === "invoice_paid").length, 2);
  writeFileSync(resolve(output), JSON.stringify({ evidence: "ACTUAL ANVIL EVM LOCAL; NOT AVALANCHE L1", chainId: 20261,
    sourceVerifiedByL04Loader: true, deployment: { ...deployment, studentSbt: await identity.getAddress(), posSigner: wallet.address, merchant: merchantAddress },
    cases, paidLogCount: 2 }, null, 2) + "\n");
  console.log("B04 Anvil: tier0/tier1 POST -> payInvoice -> RPC outage -> verified GET -> SQLite reopen with RPC offline passed.");
} finally {
  await stop(); repository.close(); provider.destroy();
  assert.ok(dir.startsWith(join(tmpdir(), "b04-evm-"))); rmSync(dir, { recursive: true, force: true });
}
