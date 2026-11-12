// Synthetic JSON-RPC, real B01/B02 HTTP services and disk SQLite. Never L1 evidence.
import assert from "node:assert/strict";
import { createServer, type Server, type RequestListener } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet, id } from "ethers";
import type { SignedInvoiceEnvelope } from "@intracampus/network";
import { createApp } from "../src/app.ts";
import { InvoiceCreationService } from "../src/modules/invoices/invoices.service.ts";
import { SqliteInvoiceRepository, type InvoiceRepository } from "../src/modules/invoices/invoices.repository.ts";
import { ReceiptService } from "../src/modules/invoices/receipt.service.ts";
import { HttpInvoiceRpc } from "../src/modules/invoices/invoices.rpc.ts";
import { paymentAbi } from "../src/modules/invoices/receipt.verifier.ts";
import { FakeRpc, blockHash, deployment, envelope as template } from "./invoices.helpers.ts";

const wallet = Wallet.fromPhrase("test test test test test test test test test test test junk");
const hex = (value: number) => `0x${value.toString(16)}`;
class BrowserRpc extends FakeRpc {
  paidIds = new Set<string>();
  override async call(method: string, params: unknown[]) {
    if (this.available && method === "eth_call") {
      const data = (params[0] as { data: string }).data;
      if (data.startsWith("0xf06da054")) return `0x${wallet.address.slice(2).toLowerCase().padStart(64, "0")}`;
      if (data.startsWith("0xdb5111ce")) return `0x${(this.paidIds.has(`0x${data.slice(10)}`) ? "1" : "0").padStart(64, "0")}`;
    }
    return super.call(method, params);
  }
}
async function listen(handler: RequestListener, port = 0) {
  const server = createServer(handler).listen(port, "127.0.0.1");
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}
const stop = (server: Server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
export async function createB04Fixture(port = 0) {
  const dir = mkdtempSync(join(tmpdir(), "b04-")), path = join(dir, "invoices.sqlite");
  let repository = new SqliteInvoiceRepository(path), clock = Date.now();
  let latest: SignedInvoiceEnvelope | null = null;
  const store: InvoiceRepository = { create(e) { repository.create(e); latest = e; }, get: (key) => repository.get(key),
    save: (key, record) => repository.save(key, record), confirm: (key, record) => repository.confirm(key, record) };
  const rpc = new BrowserRpc(); rpc.timestamp = Math.floor(Date.now() / 1000);
  const logs: Record<string, unknown>[] = [];
  const rpcServer = await listen(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const call = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    try { const result = await rpc.call(call.method, call.params); res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result })); }
    catch { res.statusCode = 503; res.end("{}"); }
  });
  const client = new HttpInvoiceRpc(rpcServer.url);
  const app = () => createApp(rpcServer.url, new ReceiptService({ repository: store, rpc: client, deployment, now: () => clock,
    log: (entry) => logs.push(entry) }), new InvoiceCreationService({ repository: store, rpc: client, deployment,
      config: { merchant: template.invoice.merchant, privateKey: wallet.privateKey } }));
  let apiServer = await listen(app(), port);
  return {
    rpc, logs, get api() { return apiServer.url; }, get latest() { return latest; },
    advance() { clock += 31000; },
    async post() {
      const response = await fetch(`${apiServer.url}/api/invoices`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchantId: "parking-demo", serviceId: "parking-single" }) });
      assert.equal(response.status, 201); return response.json();
    },
    settle(e: SignedInvoiceEnvelope, mode: "paid" | "reverted" | "mismatch" = "paid") {
      rpc.available = true; clock += 31000; rpc.head++;
      const hash = id(`${e.invoice.invoiceId}:${rpc.head}:${mode}`), amount = BigInt(e.invoice.amount), discount = amount / 10n;
      const event = paymentAbi.encodeEventLog(paymentAbi.getEvent("InvoicePaid")!, [mode === "mismatch" ? id("wrong invoice") : e.invoice.invoiceId,
        wallet.address, e.invoice.merchant, e.invoice.category, amount, discount, amount - discount, 1]);
      const log = { ...event, address: deployment.contractAddress, transactionHash: hash, blockHash, blockNumber: hex(rpc.head), logIndex: "0x0", removed: false };
      const receipt = { status: mode === "reverted" ? "0x0" : "0x1", transactionHash: hash, blockHash, blockNumber: hex(rpc.head),
        gasUsed: "0x10b44", effectiveGasPrice: "0x5d21dba00", logs: mode === "reverted" ? [] : [log] };
      rpc.receipts.set(hash, receipt); if (mode === "paid") { rpc.logs.push(log); rpc.paidIds.add(e.invoice.invoiceId); }
      return hash;
    },
    async restart() { await stop(apiServer.server); repository.close(); repository = new SqliteInvoiceRepository(path); apiServer = await listen(app(), port); },
    async close() {
      await stop(apiServer.server); await stop(rpcServer.server); repository.close();
      assert.ok(dir.startsWith(join(tmpdir(), "b04-"))); rmSync(dir, { recursive: true, force: true });
    },
  };
}
