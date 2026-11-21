import { createCanteenRouter } from './modules/canteen/canteen.routes.ts';
import type { CanteenService } from './modules/canteen/canteen.service.ts';
import express from "express";
import { createNetworkRouter } from "./modules/network/network.routes.ts";
import { createInvoicesRouter } from "./modules/invoices/invoices.routes.ts";
import type { ReceiptService } from "./modules/invoices/receipt.service.ts";
import { createGrantsRouter } from "./modules/grants/grants.routes.ts";
import type { GrantsService } from "./modules/grants/grants.service.ts";
import type { InvoiceCreationService } from "./modules/invoices/invoices.service.ts";
import { createAuthRouter } from "./modules/auth/auth.routes.ts";
import type { AuthService } from "./modules/auth/auth.service.ts";
import type { LibraryAuthConfig } from "./modules/auth/auth.config.ts";
import { createLibraryRouter } from "./modules/library/library.routes.ts";
import type { LibraryService } from "./modules/library/library.service.ts";
import type { SqliteInvoiceRepository } from "./modules/invoices/invoices.repository.ts";
import { createParkingRouter } from "./modules/parking/parking.routes.ts";
import { createCampusRouter } from "./modules/campus/campus.routes.ts";
import type { CampusService } from "./modules/campus/campus.service.ts";
import type { LibraryRepository } from "./modules/library/library.repository.ts";
import { createAdminRouter } from "./modules/admin/admin.routes.ts";
import type { AdminService } from "./modules/admin/admin.service.ts";

export function createApp(
  rpcUrl?: string,
  receiptService?: ReceiptService,
  creationService?: InvoiceCreationService,
  grantsService?: GrantsService,
  authService?: AuthService,
  authConfig?: LibraryAuthConfig,
  libraryService?: LibraryService,
  canteenService?: CanteenService,
  parkingRepository?: SqliteInvoiceRepository,
  parkingWallet?: string | (() => string | undefined),
  campusService?: CampusService,
  libraryRepository?: LibraryRepository,
  adminService?: AdminService,
) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(createNetworkRouter(rpcUrl));
  app.use(createInvoicesRouter(receiptService, creationService));
  app.use(createParkingRouter(parkingRepository, authService, authConfig, parkingWallet));
  app.use(createGrantsRouter(grantsService, authService, authConfig, libraryService));
  app.use(createLibraryRouter(libraryService, authService, authConfig));
  app.use(createCanteenRouter(canteenService, authService, authConfig, libraryService));
  app.use(createAuthRouter(authService, authConfig));
  app.use(createCampusRouter(campusService, libraryRepository));
  app.use(createAdminRouter(adminService));

  return app;
}
