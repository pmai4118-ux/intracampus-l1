import { createApp } from "./app.ts";
import { fileURLToPath } from "node:url";
import { SqliteInvoiceRepository } from "./modules/invoices/invoices.repository.ts";
import { HttpInvoiceRpc } from "./modules/invoices/invoices.rpc.ts";
import { readInvoiceDeployment } from "./modules/invoices/receipt.config.ts";
import { ReceiptService } from "./modules/invoices/receipt.service.ts";
import { GrantsService } from "./modules/grants/grants.service.ts";
import { InvoiceCreationService } from "./modules/invoices/invoices.service.ts";
import { readInvoiceCreationConfig } from "./modules/invoices/invoice.config.ts";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");

const deployment = readInvoiceDeployment(process.env);
const repository = new SqliteInvoiceRepository(process.env.INVOICES_DB_PATH?.trim()
  || fileURLToPath(new URL("../data/invoices.sqlite", import.meta.url)));
const rpc = new HttpInvoiceRpc(process.env.INTRACAMPUS_RPC_URL);
const receiptService = new ReceiptService({ repository, deployment,
  rpc, log: (entry) => console.log(JSON.stringify(entry)) });
const creationService = new InvoiceCreationService({ repository, deployment, rpc, config: readInvoiceCreationConfig(process.env) });
const grantsService = new GrantsService({ rpcUrl: process.env.INTRACAMPUS_RPC_URL });
const server = createApp(process.env.INTRACAMPUS_RPC_URL, receiptService, creationService, grantsService).listen(port, host, () => {
  console.log(`IntraCampus API listening at http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => { grantsService.close(); repository.close(); process.exit(0); }));
}
