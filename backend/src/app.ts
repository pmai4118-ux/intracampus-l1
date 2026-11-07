import express from "express";
import { probeNetwork } from "./network.ts";

export function createApp(rpcUrl?: string) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/network", async (_req, res) => {
    const result = await probeNetwork(rpcUrl);
    const status = result.status === "ready" || result.status === "not-configured" ? 200 : 503;
    res.set("Cache-Control", "no-store").status(status).json(result);
  });

  return app;
}
