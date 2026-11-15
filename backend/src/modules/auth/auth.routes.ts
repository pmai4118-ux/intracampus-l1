import express, { Router, type ErrorRequestHandler, type Request, type Response } from "express";
import { LIBRARY_REQUEST_BODY_LIMIT_BYTES, type LibraryApiErrorCode } from "@intracampus/network";
import type { LibraryAuthConfig } from "./auth.config.ts";
import { authClientAddress } from "./client-address.ts";
import { AuthError, AuthService } from "./auth.service.ts";

type FailureCode = LibraryApiErrorCode;

const messages: Record<FailureCode, string> = {
  VALIDATION_ERROR: "The request is invalid.",
  PAYLOAD_TOO_LARGE: "The request body exceeds the supported size.",
  UNAUTHENTICATED: "A valid library session is required.",
  FORBIDDEN: "The request origin or account permission is not allowed.",
  NOT_FOUND: "The requested resource was not found.",
  CONFLICT: "The request conflicts with the current state.",
  RATE_LIMITED: "Too many authentication requests. Try again after the indicated delay.",
  RPC_UNAVAILABLE: "The network service is temporarily unavailable.",
  WRONG_CHAIN: "The configured network does not match the required chain.",
  STALE_CHAIN_STATE: "The network state is too old to verify safely.",
  DATABASE_BUSY: "The database is busy. Retry the same request.",
  CONFIGURATION_ERROR: "Authentication is not configured.",
  INTERNAL_ERROR: "The request could not be completed.",
};

function sendFailure(res: Response, code: FailureCode, status: number, retryable: boolean, retryAfterSeconds?: number): void {
  res.set("Cache-Control", "no-store");
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) res.set("Retry-After", String(Math.ceil(retryAfterSeconds)));
  res.status(status).json({ error: { code, message: messages[code], retryable } });
}

function requestOriginAllowed(req: Request, config: LibraryAuthConfig): boolean {
  return req.get("Origin") === config.origin;
}

function exactBody(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const matches = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  return matches[0].slice(name.length + 1);
}

function setSessionCookie(res: Response, config: LibraryAuthConfig, token: string): void {
  const attributes = [`${config.cookieName}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${config.sessionTtlSeconds}`];
  if (config.secureCookie) attributes.push("Secure");
  res.setHeader("Set-Cookie", attributes.join("; "));
}

function clearSessionCookie(res: Response, config: LibraryAuthConfig): void {
  const attributes = [`${config.cookieName}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"];
  if (config.secureCookie) attributes.push("Secure");
  res.setHeader("Set-Cookie", attributes.join("; "));
}

function isPayloadTooLarge(error: unknown): boolean {
  return !!error && typeof error === "object" && "type" in error && error.type === "entity.too.large";
}

export function createAuthRouter(service?: AuthService, config?: LibraryAuthConfig) {
  const router = Router();
  const ready = (_req: Request, res: Response, next: (error?: unknown) => void) => {
    res.set("Cache-Control", "no-store");
    if (!service || !config) {
      sendFailure(res, "CONFIGURATION_ERROR", 503, false);
      return;
    }
    next();
  };
  const sameOrigin = (req: Request, res: Response, next: (error?: unknown) => void) => {
    if (!config || !requestOriginAllowed(req, config)) {
      sendFailure(res, "FORBIDDEN", 403, false);
      return;
    }
    next();
  };
  const json = express.json({ limit: LIBRARY_REQUEST_BODY_LIMIT_BYTES });

  router.post("/api/auth/challenge", ready, sameOrigin, json, (req, res) => {
    if (!service || !config) return sendFailure(res, "CONFIGURATION_ERROR", 503, false);
    if (!req.is("application/json") || !exactBody(req.body, ["wallet"])) return sendFailure(res, "VALIDATION_ERROR", 400, false);
    try {
      const result = service.createChallenge({ wallet: req.body.wallet,
        remoteAddress: authClientAddress(req.socket.remoteAddress ?? "", req.get("x-forwarded-for"), config.trustedProxyAddresses) });
      res.status(201).json(result);
    } catch (error) {
      if (error instanceof AuthError) sendFailure(res, error.code, error.httpStatus, error.retryable, error.retryAfterSeconds);
      else sendFailure(res, "INTERNAL_ERROR", 500, false);
    }
  });

  router.post("/api/auth/verify", ready, sameOrigin, json, (req, res) => {
    if (!service || !config) return sendFailure(res, "CONFIGURATION_ERROR", 503, false);
    if (!req.is("application/json") || !exactBody(req.body, ["challengeId", "signature"])) return sendFailure(res, "VALIDATION_ERROR", 400, false);
    try {
      const result = service.verifyChallenge({ challengeId: req.body.challengeId, signature: req.body.signature,
        remoteAddress: authClientAddress(req.socket.remoteAddress ?? "", req.get("x-forwarded-for"), config.trustedProxyAddresses) });
      setSessionCookie(res, config, result.token);
      res.status(200).json({ account: result.account, expiresAt: result.expiresAt });
    } catch (error) {
      if (error instanceof AuthError) sendFailure(res, error.code, error.httpStatus, error.retryable, error.retryAfterSeconds);
      else sendFailure(res, "INTERNAL_ERROR", 500, false);
    }
  });

  router.get("/api/auth/session", ready, (req, res) => {
    if (!service || !config) return sendFailure(res, "CONFIGURATION_ERROR", 503, false);
    try {
      const session = service.session(cookieValue(req, config.cookieName));
      if (!session) return sendFailure(res, "UNAUTHENTICATED", 401, false);
      res.json(session);
    } catch (error) {
      if (error instanceof AuthError) sendFailure(res, error.code, error.httpStatus, error.retryable, error.retryAfterSeconds);
      else sendFailure(res, "INTERNAL_ERROR", 500, false);
    }
  });

  router.post("/api/auth/logout", ready, sameOrigin, (req, res) => {
    if (!service || !config) return sendFailure(res, "CONFIGURATION_ERROR", 503, false);
    const token = cookieValue(req, config.cookieName);
    try {
      if (!service.session(token)) {
        clearSessionCookie(res, config);
        return sendFailure(res, "UNAUTHENTICATED", 401, false);
      }
      service.logout(token);
      clearSessionCookie(res, config);
      res.set("Cache-Control", "no-store").status(204).end();
    } catch (error) {
      if (error instanceof AuthError) sendFailure(res, error.code, error.httpStatus, error.retryable, error.retryAfterSeconds);
      else sendFailure(res, "INTERNAL_ERROR", 500, false);
    }
  });

  const parserErrors: ErrorRequestHandler = (error, req, res, next) => {
    if (!req.path.startsWith("/api/auth/")) return next(error);
    if (isPayloadTooLarge(error)) sendFailure(res, "PAYLOAD_TOO_LARGE", 413, false);
    else sendFailure(res, "VALIDATION_ERROR", 400, false);
  };
  router.use(parserErrors);
  return router;
}
