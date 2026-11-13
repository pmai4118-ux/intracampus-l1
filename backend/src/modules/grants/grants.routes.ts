import { Router } from "express";
import type { GrantsService } from "./grants.service.ts";
import { grantAddress, grantHash } from "./grants.rpc.ts";
import { GrantError } from "./grants.types.ts";

export function createGrantsRouter(service?: GrantsService) {
  const router = Router();
  router.get("/api/grants/:beneficiary", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const beneficiary = grantAddress(req.params.beneficiary);
      const hash = req.query.txHash;
      if (Object.keys(req.query).some((key) => key !== "txHash") || (hash !== undefined && !grantHash(hash))) throw new GrantError("INVALID_REQUEST");
      if (!service) throw new GrantError("DEPLOYMENT_NOT_CONFIGURED");
      res.json(await service.lookup(beneficiary, typeof hash === "string" ? hash : undefined));
    } catch (error) {
      const code = error instanceof GrantError ? error.code : "RPC_UNAVAILABLE";
      const status = code === "INVALID_REQUEST" ? 400 : ["RECEIPT_MISMATCH", "TX_REVERTED"].includes(code) ? 422 : 503;
      const retryable = ["RPC_UNAVAILABLE", "CHAIN_CHANGED"].includes(code);
      if (retryable) res.set("Retry-After", "2");
      res.status(status).json({ status: "unverified", chainId: 20261, balanceWei: null, error: { code, retryable } });
    }
  });
  return router;
}
