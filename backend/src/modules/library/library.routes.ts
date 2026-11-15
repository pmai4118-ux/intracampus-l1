import express, { Router, type ErrorRequestHandler, type Request, type Response } from "express";
import { LIBRARY_REQUEST_BODY_LIMIT_BYTES, type LibraryApiErrorCode, type LibrarySettlementIntentRequest,
  type LibraryAccount, type LibraryTransactionAction } from "@intracampus/network";
import type { LibraryAuthConfig } from "../auth/auth.config.ts";
import { AuthError, type AuthService } from "../auth/auth.service.ts";
import { LibraryService, LibraryServiceError } from "./library.service.ts";

const messages: Record<LibraryApiErrorCode, string> = {
  VALIDATION_ERROR: "The request is invalid.",
  PAYLOAD_TOO_LARGE: "The request body exceeds the supported size.",
  UNAUTHENTICATED: "A valid library session is required.",
  FORBIDDEN: "The account does not have permission for this action.",
  NOT_FOUND: "The requested resource was not found.",
  CONFLICT: "The request conflicts with the current state.",
  RATE_LIMITED: "Too many requests. Try again after the indicated delay.",
  RPC_UNAVAILABLE: "The network service is temporarily unavailable.",
  WRONG_CHAIN: "The configured network does not match the required chain.",
  STALE_CHAIN_STATE: "The network state is too old or has changed; retry after reconciliation.",
  DATABASE_BUSY: "The database is busy. Retry the same request.",
  CONFIGURATION_ERROR: "The Library service is not configured.",
  INTERNAL_ERROR: "The request could not be completed.",
};

function exactBody(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const matches = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : undefined;
}

function sendFailure(res: Response, code: LibraryApiErrorCode, status: number, retryable: boolean, retryAfter?: number): void {
  res.set("Cache-Control", "no-store");
  if (retryAfter !== undefined && retryAfter > 0) res.set("Retry-After", String(Math.ceil(retryAfter)));
  res.status(status).json({ error: { code, message: messages[code], retryable } });
}

function fail(res: Response, error: unknown): void {
  if (error instanceof LibraryServiceError) sendFailure(res, error.code, error.httpStatus, error.retryable, error.retryAfterSeconds);
  else if (error instanceof AuthError) sendFailure(res, error.code, error.httpStatus, error.retryable, error.retryAfterSeconds);
  else sendFailure(res, "INTERNAL_ERROR", 500, false);
}

export function createLibraryRouter(service?: LibraryService, authService?: AuthService, authConfig?: LibraryAuthConfig) {
  const router = Router();
  const json = express.json({ limit: LIBRARY_REQUEST_BODY_LIMIT_BYTES });
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  const account = (req: Request) => {
    if (!authService || !authConfig || !service) throw new LibraryServiceError("CONFIGURATION_ERROR", 503);
    let session;
    try { session = authService.session(cookieValue(req, authConfig.cookieName)); }
    catch (error) { throw error instanceof AuthError ? error : new LibraryServiceError("DATABASE_BUSY", 503, true, 1); }
    if (!session) throw new LibraryServiceError("UNAUTHENTICATED", 401);
    return { wallet: session.account.wallet as `0x${string}`, role: session.account.role } satisfies LibraryAccount;
  };
  const sameOrigin = (req: Request) => {
    if (!authConfig || req.get("Origin") !== authConfig.origin) throw new LibraryServiceError("FORBIDDEN", 403);
  };
  const ready = () => { if (!service) throw new LibraryServiceError("CONFIGURATION_ERROR", 503); };

  router.get("/api/library/books", async (req, res) => {
    try {
      ready();
      const session = account(req);
      if (Object.keys(req.query).some((key) => key !== "q") || (req.query.q !== undefined && typeof req.query.q !== "string")) {
        throw new LibraryServiceError("VALIDATION_ERROR", 400);
      }
      res.json(await service!.listBooks(session.wallet, req.query.q as string | undefined));
    } catch (error) { fail(res, error); }
  });

  router.get("/api/library/requests", async (req, res) => {
    try {
      ready();
      const session = account(req);
      if (Object.keys(req.query).some((key) => key !== "queue")
        || (req.query.queue !== undefined && req.query.queue !== "true" && req.query.queue !== "false")) {
        throw new LibraryServiceError("VALIDATION_ERROR", 400);
      }
      res.json(await service!.listRequests(session, req.query.queue === "true"));
    } catch (error) { fail(res, error); }
  });

  router.post("/api/library/requests", json, async (req, res) => {
    try {
      ready();
      sameOrigin(req);
      const session = account(req);
      if (session.role !== "STUDENT") throw new LibraryServiceError("FORBIDDEN", 403);
      if (!req.is("application/json") || !exactBody(req.body, ["bookId", "idempotencyKey"])
        || typeof req.body.bookId !== "string" || typeof req.body.idempotencyKey !== "string") {
        throw new LibraryServiceError("VALIDATION_ERROR", 400);
      }
      const result = await service!.createRequest({ account: session, bookId: req.body.bookId, idempotencyKey: req.body.idempotencyKey });
      res.status(201).json(result.request);
    } catch (error) { fail(res, error); }
  });

  router.get("/api/library/requests/:requestId", async (req, res) => {
    try {
      ready();
      res.json(await service!.getRequest(account(req), req.params.requestId));
    } catch (error) { fail(res, error); }
  });

  router.post("/api/library/requests/:requestId/transactions", json, async (req, res) => {
    try {
      ready();
      sameOrigin(req);
      const session = account(req);
      const body = req.body;
      if (!req.is("application/json") || !body || typeof body !== "object" || Array.isArray(body)
        || typeof body.action !== "string" || typeof body.txHash !== "string") throw new LibraryServiceError("VALIDATION_ERROR", 400);
      const action = body.action as LibraryTransactionAction;
      const settles = action === "return" || action === "settle";
      if (!exactBody(body, settles ? ["action", "txHash", "settlementIntentId"] : ["action", "txHash"])
        || (settles && typeof body.settlementIntentId !== "string")
        || !["deposit", "approve", "reject", "refund", "confirmReturn", "return", "settle", "payShortfall"].includes(action)) {
        throw new LibraryServiceError("VALIDATION_ERROR", 400);
      }
      const result = await service!.submitTransaction(session, req.params.requestId, { action, txHash: body.txHash,
        ...(settles ? { settlementIntentId: body.settlementIntentId as string } : {}) });
      res.status(result.transaction?.status === "CONFIRMED" || result.transaction?.status === "REVERTED" ? 200 : 202).json(result);
    } catch (error) { fail(res, error); }
  });

  router.get("/api/library/loans", async (req, res) => {
    try {
      ready();
      const session = account(req);
      if (Object.keys(req.query).some((key) => key !== "borrowerWallet")
        || (req.query.borrowerWallet !== undefined && typeof req.query.borrowerWallet !== "string")) {
        throw new LibraryServiceError("VALIDATION_ERROR", 400);
      }
      res.json(await service!.listLoans(session, req.query.borrowerWallet as string | undefined));
    } catch (error) { fail(res, error); }
  });

  router.post("/api/library/loans/:loanId/return-requests", json, async (req, res) => {
    try {
      ready();
      sameOrigin(req);
      const session = account(req);
      if (!req.is("application/json") || !exactBody(req.body, [])) throw new LibraryServiceError("VALIDATION_ERROR", 400);
      res.status(201).json(await service!.requestReturn(session, req.params.loanId));
    } catch (error) { fail(res, error); }
  });

  router.post("/api/library/loans/:loanId/settlement-intents", json, async (req, res) => {
    try {
      ready();
      sameOrigin(req);
      const session = account(req);
      if (!req.is("application/json") || !req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        throw new LibraryServiceError("VALIDATION_ERROR", 400);
      }
      let body: LibrarySettlementIntentRequest;
      if (req.body.outcome === "RETURNED" && exactBody(req.body, ["outcome", "condition", "reason", "repairRequestedWei"])
        && (req.body.condition === "GOOD" || req.body.condition === "DAMAGED")
        && typeof req.body.reason === "string" && typeof req.body.repairRequestedWei === "string") {
        body = { outcome: "RETURNED", condition: req.body.condition, reason: req.body.reason, repairRequestedWei: req.body.repairRequestedWei };
      } else if (req.body.outcome === "LOST" && exactBody(req.body, ["outcome", "reason"]) && typeof req.body.reason === "string") {
        body = { outcome: "LOST", reason: req.body.reason };
      } else throw new LibraryServiceError("VALIDATION_ERROR", 400);
      res.status(201).json(await service!.createSettlementIntent(session, req.params.loanId, body));
    } catch (error) { fail(res, error); }
  });

  router.get("/api/library/account-status", async (req, res) => {
    try { ready(); res.json(await service!.accountStatus(account(req))); }
    catch (error) { fail(res, error); }
  });

  const parserErrors: ErrorRequestHandler = (error, req, res, next) => {
    if (!req.path.startsWith("/api/library/")) return next(error);
    if (error && typeof error === "object" && "type" in error && error.type === "entity.too.large") {
      sendFailure(res, "PAYLOAD_TOO_LARGE", 413, false);
    } else sendFailure(res, "VALIDATION_ERROR", 400, false);
  };
  router.use(parserErrors);
  return router;
}
