import { Router, type Request, type Response } from "express";
import { isParkingInvoice, type ParkingCheckout } from "@intracampus/network";
import type { LibraryAuthConfig } from "../auth/auth.config.ts";
import { readSessionCookie } from "../auth/auth.routes.ts";
import { AuthError, type AuthService } from "../auth/auth.service.ts";
import type { SqliteInvoiceRepository } from "../invoices/invoices.repository.ts";
import { isHash, same } from "../invoices/invoices.schema.ts";

export function createParkingRouter(repository?: SqliteInvoiceRepository, auth?: AuthService, config?: LibraryAuthConfig,
  parkingWallet?: string) {
  const router = Router();
  const fail = (res: Response, status: number, code: string) => res.status(status).json({ error: { code } });

  function sessionAccount(req: Request) {
    if (!auth || !config) throw new AuthError("CONFIGURATION_ERROR");
    const session = auth.session(readSessionCookie(req, config.cookieName));
    if (!session) throw new AuthError("UNAUTHENTICATED");
    return session.account;
  }
  function handleFailure(res: Response, error: unknown) {
    if (error instanceof AuthError) return fail(res, error.httpStatus, error.code);
    return fail(res, 500, "INTERNAL_ERROR");
  }

  router.use("/api/parking", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/api/parking/tickets", (req, res) => {
    if (!repository) return fail(res, 503, "CONFIGURATION_ERROR");
    try {
      const account = sessionAccount(req);
      if (account.role !== "STUDENT" || !same(req.get("X-Campus-Wallet"), account.wallet)) {
        return fail(res, 403, "FORBIDDEN");
      }
      return res.json({ tickets: repository.openParkingTickets(account.wallet) });
    } catch (error) {
      return handleFailure(res, error);
    }
  });

  function visit(req: Request<{ invoiceId: string }>, res: Response) {
    const { invoiceId } = req.params;
    if (!isHash(invoiceId)) return fail(res, 400, "INVALID_REQUEST");
    if (!repository) return fail(res, 503, "CONFIGURATION_ERROR");

    try {
      const confirm = req.method === "POST";
      if (confirm) {
        if (!parkingWallet) return fail(res, 503, "CONFIGURATION_ERROR");
        const operator = sessionAccount(req);
        if (req.get("Origin") !== config?.origin || operator.role !== "PARKING" || !same(operator.wallet, parkingWallet)) {
          return fail(res, 403, "FORBIDDEN");
        }
      }

      const record = repository.get(invoiceId);
      if (!record || !isParkingInvoice(record.envelope)) return fail(res, 404, "PARKING_TICKET_NOT_FOUND");
      if (!record.receipt) return fail(res, 409, "PARKING_PAYMENT_REQUIRED");

      const result: ParkingCheckout = {
        invoiceCode: record.envelope.meta.invoiceCode,
        checkedOutAt: confirm
          ? repository.recordParkingCheckout(invoiceId, Math.floor(Date.now() / 1000))
          : repository.parkingCheckoutAt(invoiceId),
      };
      return res.json(result);
    } catch (error) {
      return handleFailure(res, error);
    }
  }

  router.get("/api/parking/:invoiceId", visit);
  router.post("/api/parking/:invoiceId", visit);
  return router;
}
