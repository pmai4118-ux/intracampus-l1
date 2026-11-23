import { CanteenRepository, demoDishes } from './modules/canteen/canteen.repository.ts';
import { CanteenService } from './modules/canteen/canteen.service.ts';
import { createApp } from "./app.ts";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
import { SqliteInvoiceRepository } from "./modules/invoices/invoices.repository.ts";
import { HttpInvoiceRpc } from "./modules/invoices/invoices.rpc.ts";
import { readInvoiceDeployment } from "./modules/invoices/receipt.config.ts";
import { ReceiptService } from "./modules/invoices/receipt.service.ts";
import { GrantsService } from "./modules/grants/grants.service.ts";
import { InvoiceCreationService } from "./modules/invoices/invoices.service.ts";
import { readInvoiceCreationConfig } from "./modules/invoices/invoice.config.ts";
import { isAddress } from "./modules/invoices/invoices.schema.ts";
import { readInvoiceChainFreshness } from "./modules/invoices/chain-freshness.ts";
import { LibraryRepository } from "./modules/library/library.repository.ts";
import { AuthRepository } from "./modules/auth/auth.repository.ts";
import { AuthService } from "./modules/auth/auth.service.ts";
import { readLibraryAuthConfig, type LibraryAuthConfig } from "./modules/auth/auth.config.ts";
import { readLibraryConfig } from "./modules/library/library.config.ts";
import { LibraryService } from "./modules/library/library.service.ts";
import { CAMPUS_CHAIN_ID, CLOUD_CAMPUS_CHAIN_ID, selectedDeploymentManifest as libraryManifest } from "@intracampus/network";
import { CampusRepository } from "./modules/campus/campus.repository.ts";
import { CampusService } from "./modules/campus/campus.service.ts";
import { readAdminConfig, type AdminConfig } from "./modules/admin/admin.config.ts";
import { AdminRepository } from "./modules/admin/admin.repository.ts";
import { AdminService } from "./modules/admin/admin.service.ts";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");

if (CAMPUS_CHAIN_ID === CLOUD_CAMPUS_CHAIN_ID) {
  const databasePaths = [process.env.INVOICES_DB_PATH, process.env.LIBRARY_DB_PATH, process.env.CANTEEN_DB_PATH, process.env.CAMPUS_DB_PATH]
    .map((value) => value?.trim() ?? "");
  if (databasePaths.some((value) => !isAbsolute(value)) || new Set(databasePaths.map((value) => resolve(value))).size !== 4) {
    throw new Error("Cloud demo requires four distinct absolute database paths");
  }
}

const adminDbPath = process.env.ADMIN_DB_PATH?.trim()
  || (CAMPUS_CHAIN_ID === CLOUD_CAMPUS_CHAIN_ID && process.env.CAMPUS_DB_PATH?.trim()
    ? resolve(dirname(process.env.CAMPUS_DB_PATH.trim()), "admin.sqlite")
    : fileURLToPath(new URL("../data/admin.sqlite", import.meta.url)));

const deployment = readInvoiceDeployment(process.env);
const repository = new SqliteInvoiceRepository(process.env.INVOICES_DB_PATH?.trim()
  || fileURLToPath(new URL("../data/invoices.sqlite", import.meta.url)));
const rpc = new HttpInvoiceRpc(process.env.INTRACAMPUS_RPC_URL);
const invoiceChainFreshness = readInvoiceChainFreshness(process.env);
const receiptService = new ReceiptService({ repository, deployment,
  rpc, chainFreshness: invoiceChainFreshness, log: (entry) => console.log(JSON.stringify(entry)) });
const invoiceConfig = readInvoiceCreationConfig(process.env);
const libraryRepository = new LibraryRepository(process.env.LIBRARY_DB_PATH?.trim()
  || fileURLToPath(new URL("../data/library.sqlite", import.meta.url)));
const campusRepository = new CampusRepository(process.env.CAMPUS_DB_PATH?.trim()
  || fileURLToPath(new URL('../data/campus.sqlite', import.meta.url)));
const adminRepository = new AdminRepository(adminDbPath);
let adminConfig: AdminConfig | undefined;
try { adminConfig = readAdminConfig(process.env); }
catch { /* Admin endpoints fail closed until ADMIN_ACCESS_KEY and origin are configured. */ }
const adminService = new AdminService({
  config: adminConfig,
  repository: adminRepository,
  libraryRepository,
  campusRepository,
  rpcUrl: process.env.INTRACAMPUS_RPC_URL?.trim() || undefined,
  allowLocal: process.env.ADMIN_ALLOW_LOCAL_ANVIL === "true"
    || process.env.CAMPUS_ALLOW_LOCAL_ANVIL === "true"
    || process.env.LIBRARY_ALLOW_LOCAL_ANVIL === "true",
  deployment: libraryManifest,
});

const creationService = new InvoiceCreationService({ repository, deployment, rpc, chainFreshness: invoiceChainFreshness,
  config: invoiceConfig, resolveParkingMerchant: () => adminService.activeParkingMerchant() });
const grantsService = new GrantsService({ rpcUrl: process.env.INTRACAMPUS_RPC_URL,
  resolveCanteenMerchant: () => adminService.activeCanteenMerchant() });
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
const activeParkingAtStart = adminService.activeParkingMerchant() ?? invoiceConfig.merchant;
if (authService && isAddress(activeParkingAtStart)) {
  try {
    libraryRepository.registerParkingOperator(activeParkingAtStart);
  } catch {
    console.error("Parking checkout is disabled: could not register the configured Parking wallet.");
  }
}
const canteenRepository = new CanteenRepository(process.env.CANTEEN_DB_PATH?.trim() || fileURLToPath(new URL('../data/canteen.sqlite',import.meta.url)));
canteenRepository.syncCatalogPrices(demoDishes);
const canteenService = new CanteenService(canteenRepository, { rpc, invoices: creationService, receipts: receiptService,
  grants: grantsService, resolveCanteenMerchant: () => adminService.activeCanteenMerchant() });
let campusService: CampusService | undefined;
try {
  campusService = new CampusService(campusRepository, process.env, rpc, undefined,
    () => adminService.campusOverrides(), adminService.nativeMinter);
  adminService.setWelcomeIssuer(async (wallet) => {
    const payout = await campusService!.issueWelcome(wallet);
    return { status: payout.status === "CONFIRMED" ? "CONFIRMED" : payout.status === "FAILED" ? "FAILED" : "PENDING", txHash: payout.txHash };
  });
}
catch { /* Campus endpoints fail closed until origin and authority configuration are valid. */ }
const server = createApp(process.env.INTRACAMPUS_RPC_URL, receiptService, creationService, grantsService,
  authService, libraryAuthConfig, libraryService, canteenService, repository,
  () => adminService.activeParkingMerchant() ?? invoiceConfig.merchant,
  campusService, libraryRepository, adminService).listen(port, host, () => {
  console.log(`IntraCampus API listening at http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => { adminService.close(); adminRepository.close(); campusRepository.close(); canteenRepository.close(); grantsService.close(); libraryService.close(); libraryRepository.close(); repository.close(); process.exit(0); }));
}
