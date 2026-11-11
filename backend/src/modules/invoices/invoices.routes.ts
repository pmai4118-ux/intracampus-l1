import { Router } from "express";
import { InvoiceRequestError, invoiceError, type ReceiptService } from "./receipt.service.ts";
import { isHash } from "./invoices.schema.ts";

export function createInvoicesRouter(service?: ReceiptService) {
  const router = Router();
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
