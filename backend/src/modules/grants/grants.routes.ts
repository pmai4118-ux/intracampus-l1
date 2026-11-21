import { CAMPUS_CHAIN_ID } from "@intracampus/network";
import { Router } from "express";
import type { GrantsService } from "./grants.service.ts";
import { grantAddress, grantHash } from "./grants.rpc.ts";
import { GrantError } from "./grants.types.ts";
import type { AuthService } from "../auth/auth.service.ts";
import type { LibraryAuthConfig } from "../auth/auth.config.ts";
import type { LibraryService } from "../library/library.service.ts";

export function createGrantsRouter(service?: GrantsService, authService?: AuthService, authConfig?: LibraryAuthConfig,
  libraryService?: LibraryService) {
  const router = Router();
  router.get("/api/grants/:beneficiary", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const beneficiary = grantAddress(req.params.beneficiary);
      const hash = req.query.txHash;
      if (Object.keys(req.query).some((key) => key !== "txHash") || (hash !== undefined && !grantHash(hash))) throw new GrantError("INVALID_REQUEST");
      if (!service) throw new GrantError("DEPLOYMENT_NOT_CONFIGURED");
      if (authService || authConfig || libraryService) {
        if (!authService || !authConfig || !libraryService) {
          res.status(503).json({ status: "unverified", chainId: CAMPUS_CHAIN_ID, balanceWei: null,
            error: { code: "CONFIGURATION_ERROR", retryable: false } });
          return;
        }
        const cookie = req.headers.cookie?.split(";").map((part) => part.trim())
          .filter((part) => part.startsWith(`${authConfig.cookieName}=`));
        const session = cookie?.length === 1 ? authService.session(cookie[0].slice(authConfig.cookieName.length + 1)) : null;
        if (!session) {
          res.status(401).json({ status: "unverified", chainId: CAMPUS_CHAIN_ID, balanceWei: null,
            error: { code: "UNAUTHENTICATED", retryable: false } });
          return;
        }
        if (session.account.role === "PARKING" || session.account.wallet.toLowerCase() !== beneficiary.toLowerCase()) {
          res.status(403).json({ status: "unverified", chainId: CAMPUS_CHAIN_ID, balanceWei: null,
            error: { code: "FORBIDDEN", retryable: false } });
          return;
        }
        const accountStatus = await libraryService.accountStatus({
          wallet: session.account.wallet as `0x${string}`, role: session.account.role,
        });
        // Held students cannot start grant activity; their own transaction hash
        // remains readable so an already-sent spend can still be reconciled.
        if (accountStatus.held && hash === undefined) {
          res.status(403).json({ status: "unverified", chainId: CAMPUS_CHAIN_ID, balanceWei: null,
            error: { code: "FORBIDDEN", retryable: false } });
          return;
        }
      }
      res.json(await service.lookup(beneficiary, typeof hash === "string" ? hash : undefined));
    } catch (error) {
      if (error && typeof error === "object" && "httpStatus" in error && typeof error.httpStatus === "number"
        && "code" in error && typeof error.code === "string") {
        const status = error.httpStatus;
        const retryable = "retryable" in error && error.retryable === true;
        const retryAfterSeconds = "retryAfterSeconds" in error && typeof error.retryAfterSeconds === "number"
          ? error.retryAfterSeconds : 2;
        if (retryable) res.set("Retry-After", String(Math.ceil(retryAfterSeconds)));
        res.status(status).json({ status: "unverified", chainId: CAMPUS_CHAIN_ID, balanceWei: null,
          error: { code: error.code, retryable } });
        return;
      }
      const code = error instanceof GrantError ? error.code : "RPC_UNAVAILABLE";
      const status = code === "INVALID_REQUEST" ? 400 : ["RECEIPT_MISMATCH", "TX_REVERTED"].includes(code) ? 422 : 503;
      const retryable = ["RPC_UNAVAILABLE", "CHAIN_CHANGED"].includes(code);
      if (retryable) res.set("Retry-After", "2");
      res.status(status).json({ status: "unverified", chainId: CAMPUS_CHAIN_ID, balanceWei: null, error: { code, retryable } });
    }
  });
  return router;
}
