import express from "express";
import { createNetworkRouter } from "./modules/network/network.routes.ts";
import { createInvoicesRouter } from "./modules/invoices/invoices.routes.ts";
import type { ReceiptService } from "./modules/invoices/receipt.service.ts";
import { createGrantsRouter } from "./modules/grants/grants.routes.ts";
import type { GrantsService } from "./modules/grants/grants.service.ts";
import type { InvoiceCreationService } from "./modules/invoices/invoices.service.ts";

export function createApp(rpcUrl?: string, receiptService?: ReceiptService, creationService?: InvoiceCreationService, grantsService?: GrantsService) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(createNetworkRouter(rpcUrl));
  app.use(createInvoicesRouter(receiptService, creationService));
  app.use(createGrantsRouter(grantsService));

  return app;
}
