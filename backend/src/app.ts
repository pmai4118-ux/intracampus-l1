import express from "express";
import { createNetworkRouter } from "./modules/network/network.routes.ts";

export function createApp(rpcUrl?: string) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(createNetworkRouter(rpcUrl));

  return app;
}
