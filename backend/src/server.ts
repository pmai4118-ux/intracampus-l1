import { CanteenRepository } from './modules/canteen/canteen.repository.ts';
import { CanteenService } from './modules/canteen/canteen.service.ts';
import { createApp } from "./app.ts";
import { fileURLToPath } from "node:url";
import { SqliteInvoiceRepository } from "./modules/invoices/invoices.repository.ts";
import { HttpInvoiceRpc } from "./modules/invoices/invoices.rpc.ts";
import { readInvoiceDeployment } from "./modules/invoices/receipt.config.ts";
import { ReceiptService } from "./modules/invoices/receipt.service.ts";
import { GrantsService } from "./modules/grants/grants.service.ts";
import { InvoiceCreationService } from "./modules/invoices/invoices.service.ts";
import { readInvoiceCreationConfig } from "./modules/invoices/invoice.config.ts";
import { readInvoiceChainFreshness } from "./modules/invoices/chain-freshness.ts";
import { LibraryRepository } from "./modules/library/library.repository.ts";
import { AuthRepository } from "./modules/auth/auth.repository.ts";
import { AuthService } from "./modules/auth/auth.service.ts";
import { readLibraryAuthConfig, type LibraryAuthConfig } from "./modules/auth/auth.config.ts";
import { readLibraryConfig } from "./modules/library/library.config.ts";
import { LibraryService } from "./modules/library/library.service.ts";
import libraryManifest from "../../deployments/intracampus.json" with { type: "json" };

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");

const deployment = readInvoiceDeployment(process.env);
const repository = new SqliteInvoiceRepository(process.env.INVOICES_DB_PATH?.trim()
  || fileURLToPath(new URL("../data/invoices.sqlite", import.meta.url)));
const rpc = new HttpInvoiceRpc(process.env.INTRACAMPUS_RPC_URL);
const invoiceChainFreshness = readInvoiceChainFreshness(process.env);
const receiptService = new ReceiptService({ repository, deployment,
  rpc, chainFreshness: invoiceChainFreshness, log: (entry) => console.log(JSON.stringify(entry)) });
const creationService = new InvoiceCreationService({ repository, deployment, rpc, chainFreshness: invoiceChainFreshness,
  config: readInvoiceCreationConfig(process.env) });
const grantsService = new GrantsService({ rpcUrl: process.env.INTRACAMPUS_RPC_URL });
const libraryRepository = new LibraryRepository(process.env.LIBRARY_DB_PATH?.trim()
  || fileURLToPath(new URL("../data/library.sqlite", import.meta.url)));
let libraryService = new LibraryService(libraryRepository);
try { libraryService = new LibraryService(libraryRepository, readLibraryConfig(process.env, libraryManifest)); }
catch {
  // Keep unrelated API modules available; Library business endpoints fail closed with CONFIGURATION_ERROR.
}
let libraryAuthConfig: LibraryAuthConfig | undefined;
let authService: AuthService | undefined;
try {
  libraryAuthConfig = readLibraryAuthConfig(process.env);
  authService = new AuthService(new AuthRepository(libraryRepository), libraryAuthConfig);
} catch {
  // Keep unrelated API modules available; auth endpoints fail closed with CONFIGURATION_ERROR.
}
const canteenRepository = new CanteenRepository(process.env.CANTEEN_DB_PATH?.trim() || fileURLToPath(new URL('../data/canteen.sqlite',import.meta.url)));
const canteenService = new CanteenService(canteenRepository, { rpc, invoices: creationService, receipts: receiptService, grants: grantsService });
const server = createApp(process.env.INTRACAMPUS_RPC_URL, receiptService, creationService, grantsService,
  authService, libraryAuthConfig, libraryService, canteenService).listen(port, host, () => {
  console.log(`IntraCampus API listening at http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => { canteenRepository.close(); grantsService.close(); libraryService.close(); libraryRepository.close(); repository.close(); process.exit(0); }));
}
