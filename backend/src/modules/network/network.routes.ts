import { Router } from "express";
import { deploymentResponse } from "@intracampus/network";
import { probeNetwork } from "./network.service.ts";

export function createNetworkRouter(rpcUrl?: string) {
  const router = Router();

  router.get("/api/deployment", (_req, res) => {
    const result = deploymentResponse();
    res.set("Cache-Control", "no-store").status(result.status).json(result.body);
  });

  router.get("/api/network", async (_req, res) => {
    const result = await probeNetwork(rpcUrl);
    const status = result.status === "ready" || result.status === "not-configured" ? 200 : 503;
    res.set("Cache-Control", "no-store").status(status).json(result);
  });

  return router;
}
