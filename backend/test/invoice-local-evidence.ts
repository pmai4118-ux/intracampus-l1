// Integration evidence for an explicitly local Anvil, never for a public L1.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ContractFactory, JsonRpcProvider, Wallet, id } from "ethers";
import { createApp } from "../src/app.ts";
import { InvoiceCreationService } from "../src/modules/invoices/invoices.service.ts";
import { SqliteInvoiceRepository } from "../src/modules/invoices/invoices.repository.ts";
import { HttpInvoiceRpc } from "../src/modules/invoices/invoices.rpc.ts";
import { ReceiptService } from "../src/modules/invoices/receipt.service.ts";

const [contractsRoot, evidencePath] = process.argv.slice(2);
assert.ok(contractsRoot && evidencePath, "Usage: node test/invoice-local-evidence.ts <L04 contracts root> <evidence path>");
const root = resolve(contractsRoot);
// L04's loader checks artifact metadata against the Solidity sources/dependencies.
const { loadVerifiedArtifact } = await import(pathToFileURL(join(root, "script/load-verified-artifact.mjs")).href);
const paymentArtifact = await loadVerifiedArtifact(root, "CampusPaymentRegistry");
const identityArtifact = await loadVerifiedArtifact(root, "StudentSBTIdentity");
const url = "http://127.0.0.1:18547";
const provider = new JsonRpcProvider(url, 20261, { staticNetwork: true, cacheTimeout: -1 });
provider.pollingInterval = 50;
const repository = new SqliteInvoiceRepository(":memory:");
let server: ReturnType<typeof createServer> | undefined;
try {
  assert.match(await provider.send("web3_clientVersion", []), /anvil/i);
  assert.equal(BigInt(await provider.send("eth_chainId", [])), 20261n);
  const admin = await provider.getSigner(0);
  const merchant = await provider.getSigner(1);
  const payer = await provider.getSigner(2);
  const payerAddress = await payer.getAddress();
  const wallet = Wallet.fromPhrase("test test test test test test test test test test test junk");
  assert.equal(await admin.getAddress(), wallet.address);
  const identity = await new ContractFactory(identityArtifact.abi, identityArtifact.bytecode.object, admin).deploy(wallet.address);
  await identity.waitForDeployment();
  const payment = await new ContractFactory(paymentArtifact.abi, paymentArtifact.bytecode.object, admin)
    .deploy(wallet.address, wallet.address, await identity.getAddress());
  await payment.waitForDeployment();
  const contractAddress = await payment.getAddress();
  const merchantAddress = await merchant.getAddress();
  await (await payment.getFunction("setMerchantCategory")(merchantAddress, id("PARKING"), true)).wait();
  const deployment = { contractAddress, deploymentBlock: (await payment.deploymentTransaction()!.wait())!.blockNumber };
  const rpc = new HttpInvoiceRpc(url);
  const creation = new InvoiceCreationService({ repository, rpc, deployment,
    config: { merchant: merchantAddress, privateKey: wallet.privateKey } });
  const receiptService = new ReceiptService({ repository, rpc, deployment });
  server = createServer(createApp(url, receiptService, creation)).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const api = `http://127.0.0.1:${address.port}`;
  async function post() {
    const response = await fetch(`${api}/api/invoices`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId: "parking-demo", serviceId: "parking-single" }) });
    assert.equal(response.status, 201);
    return response.json();
  }
  const fresh = await post();
  const e = fresh.envelope;
  const tuple = (invoice: typeof e.invoice) => [invoice.invoiceId, invoice.merchant, invoice.category, invoice.amount, invoice.expiresAt];
  const connected = payment.connect(payer);
  const tx = await connected.getFunction("payInvoice")(tuple(e.invoice), e.signature, { value: BigInt(e.invoice.amount) });
  const receipt = await tx.wait(); assert.equal(receipt.status, 1);
  const paidResponse = await fetch(`${api}/api/invoices/${fresh.invoiceId}?txHash=${tx.hash}`);
  assert.equal(paidResponse.status, 200);
  const paid = await paidResponse.json(); assert.equal(paid.status, "paid");
  const expiring = await post();
  const old = expiring.envelope;
  await provider.send("evm_setNextBlockTimestamp", [old.invoice.expiresAt + 1]);
  await provider.send("evm_mine", []);
  const rejected: string[] = [];
  for (const action of [
    () => payment.getFunction("quoteInvoice")(tuple(old.invoice), payerAddress),
    () => connected.getFunction("payInvoice").staticCall(tuple(old.invoice), old.signature, { value: BigInt(old.invoice.amount) }),
  ]) {
    try { await action(); assert.fail("Expired invoice unexpectedly accepted"); }
    catch (error) {
      const data = (error as { data?: string }).data;
      const decoded = data ? payment.interface.parseError(data) : null;
      assert.equal(decoded?.name, "InvoiceExpired"); rejected.push(decoded!.name);
    }
  }
  assert.equal(await payment.getFunction("isInvoicePaid")(old.invoice.invoiceId), false);
  writeFileSync(resolve(evidencePath), `${JSON.stringify({ environment: "Anvil EVM local; not Avalanche L1",
    chainId: 20261, contractAddress, sourceVerifiedByL04Loader: true, paidInvoice: e,
    txHash: tx.hash, verifiedReceipt: paid.receipt, expiredInvoice: old,
    rejectionTimestamp: old.invoice.expiresAt + 1, quoteAndPayErrors: rejected,
  }, null, 2)}\n`);
  console.log("B01 HTTP invoice accepted by L04; B02 verified receipt; expired quote/pay rejected (Anvil local).");
} finally {
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  repository.close(); provider.destroy();
}
