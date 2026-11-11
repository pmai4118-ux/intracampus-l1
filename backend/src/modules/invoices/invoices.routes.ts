import express, { Router, type ErrorRequestHandler } from "express";
import { InvoiceCreationError, validateInvoiceRequest, type InvoiceCreationService } from "./invoices.service.ts";
import { InvoiceRequestError, invoiceError, type ReceiptService } from "./receipt.service.ts";
import { isHash } from "./invoices.schema.ts";

export function createInvoicesRouter(service?: ReceiptService, creation?: InvoiceCreationService) {
  const router = Router();
  router.post("/api/invoices", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); },
    express.json({ limit: "8kb" }), async (req, res) => {
      try {
        if (!req.is("application/json")) throw new InvoiceCreationError("INVALID_REQUEST");
        validateInvoiceRequest(req.body);
        if (!creation) throw new InvoiceCreationError("RPC_UNAVAILABLE");
        res.status(201).json(await creation.create(req.body));
      } catch (error) {
        const failure = error instanceof InvoiceCreationError ? error : new InvoiceCreationError("INTERNAL_ERROR");
        res.status(failure.httpStatus).json(failure.body);
      }
    });
  const jsonError: ErrorRequestHandler = (error, req, res, next) => {
    if (req.method !== "POST" || req.path !== "/api/invoices") return next(error);
    const failure = new InvoiceCreationError("INVALID_REQUEST");
    res.status(failure.httpStatus).json(failure.body);
  };
  router.use(jsonError);
  router.get("/api/invoices/:invoiceId", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!isHash(req.params.invoiceId) || Object.keys(req.query).some((key) => key !== "txHash")
        || (req.query.txHash !== undefined && !isHash(req.query.txHash))) throw new InvoiceRequestError("INVALID_REQUEST");
      if (!service) throw new InvoiceRequestError("INVOICE_NOT_FOUND");
      const result = await service.lookup(req.params.invoiceId, req.query.txHash as string | undefined);
      if (result.retryAfterSeconds) res.set("Retry-After", result.retryAfterSeconds.toString());
      res.status(result.httpStatus).json(result.body);
    } catch (error) {
      if (error instanceof InvoiceRequestError) res.status(error.httpStatus).json({ error: invoiceError(error.code) });
      else res.status(500).json({ error: invoiceError("INTERNAL_ERROR") });
    }
  });
  return router;
}
