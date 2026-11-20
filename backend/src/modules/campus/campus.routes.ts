import express, { Router, type Request, type ErrorRequestHandler } from "express";
import { getAddress } from "ethers";
import { createAuthRouter, readSessionCookie } from "../auth/auth.routes.ts";
import { CampusService } from "./campus.service.ts";
import { CampusError } from "./campus.repository.ts";
import type { LibraryRepository } from "../library/library.repository.ts";
function body(value: any, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join()) throw new CampusError("INVALID_REQUEST", 400);
}
function walletAddress(value: unknown) {
  try {
    if (typeof value !== "string" || /^0x0{40}$/i.test(value)) throw Error();
    return getAddress(value);
  } catch { throw new CampusError("INVALID_REQUEST", 400); }
}
export function createCampusRouter(service?: CampusService, library?: LibraryRepository) {
  const router = Router();
  router.use(createAuthRouter(service?.auth, service?.authConfig, "/api/campus/auth"));
  router.use("/api/campus", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!service) return res.status(503).json({ error: { code: "CONFIGURATION_ERROR" } });
    if (req.method !== "GET" && req.get("Origin") !== service.authConfig.origin) return res.status(403).json({ error: { code: "FORBIDDEN" } });
    next();
  });
  router.use("/api/campus", express.json({ limit: "8kb" }));
  const actor = (req: Request) => {
    const session = service!.auth.session(readSessionCookie(req, service!.authConfig.cookieName));
    if (!session) throw new CampusError("UNAUTHENTICATED", 401); return session.account.wallet.toLowerCase();
  };
  const school = (req: Request) => { const wallet = actor(req); service!.requireSchool(wallet); return wallet; };
  router.get("/api/campus/me", (req, res, next) => { try { const wallet = actor(req); res.json({ wallet, school: service!.schools.has(wallet), profile: service!.repository.profile(wallet) }); } catch (e) { next(e); } });
  router.post("/api/campus/applications", (req, res, next) => { try {
    const wallet = actor(req); body(req.body, ["studentCode", "program"]);
    const { studentCode, program } = req.body;
    if (typeof studentCode !== "string" || !/^[A-Z0-9-]{4,32}$/.test(studentCode) || typeof program !== "string" || !program.trim() || program.length > 100 || /[\x00-\x1f]/.test(program)) throw new CampusError("INVALID_REQUEST", 400);
    res.json(service!.repository.submit(wallet, studentCode, program.trim()));
  } catch (e) { next(e); } });
  router.post("/api/campus/scholarships", (req, res, next) => { try {
    const wallet = actor(req); body(req.body, ["category"]); if (!["MERIT", "SUPPORT"].includes(req.body.category)) throw new CampusError("INVALID_REQUEST", 400);
    res.json(service!.repository.requestScholarship(wallet, req.body.category));
  } catch (e) { next(e); } });
  router.post("/api/campus/activate", (req, res, next) => { try {
    const wallet = actor(req); body(req.body, []);
    if (service!.repository.profile(wallet).application?.status !== "APPROVED") throw new CampusError("STUDENT_NOT_VERIFIED", 403);
    if (!library) throw new CampusError("CONFIGURATION_ERROR", 503);
    library.enrollVerifiedStudent(wallet); res.json({ activated: true });
  } catch (e) { next(e); } });
  router.get("/api/campus/reviews", (req, res, next) => { try { school(req); res.json({ profiles: service!.repository.list() }); } catch (e) { next(e); } });
  router.post("/api/campus/reviews", (req, res, next) => { try {
    const reviewer = school(req); body(req.body, ["wallet", "kind", "approve", "reason"]);
    const { wallet, kind, approve, reason } = req.body;
    if (typeof wallet !== "string" || !["STUDENT", "SCHOLARSHIP"].includes(kind) || typeof approve !== "boolean" || !["VERIFIED", "INCOMPLETE", "IDENTITY_MISMATCH", "NOT_ELIGIBLE"].includes(reason)
      || (approve && reason !== "VERIFIED") || (!approve && reason === "VERIFIED")) throw new CampusError("INVALID_REQUEST", 400);
    res.json(service!.repository.review(reviewer, walletAddress(wallet), kind, approve, reason));
  } catch (e) { next(e); } });
  router.post("/api/campus/payouts", async (req, res, next) => { try {
    const issuer = school(req); body(req.body, ["wallet", "kind"]);
    if (typeof req.body.wallet !== "string" || !["WELCOME", "SCHOLARSHIP"].includes(req.body.kind)) throw new CampusError("INVALID_REQUEST", 400);
    res.json(await service!.prepare(issuer, walletAddress(req.body.wallet), req.body.kind));
  } catch (e) { next(e); } });
  router.post("/api/campus/payouts/:id/begin", async (req, res, next) => { try {
    const issuer = school(req); body(req.body, []); res.json(await service!.begin(String(req.params.id), issuer));
  } catch (e) { next(e); } });
  router.post("/api/campus/payouts/:id/reconcile", async (req, res, next) => { try {
    school(req); body(req.body, ["txHash"]); if (typeof req.body.txHash !== "string") throw new CampusError("INVALID_REQUEST", 400);
    res.json(await service!.reconcile(String(req.params.id), req.body.txHash));
  } catch (e) { next(e); } });
  const fail: ErrorRequestHandler = (error, req, res, next) => {
    if (!req.path.startsWith("/api/campus")) return next(error);
    const parserCode = error?.type === "entity.too.large" ? "PAYLOAD_TOO_LARGE" : error?.type === "entity.parse.failed" ? "INVALID_REQUEST" : null;
    res.status(error instanceof CampusError ? error.httpStatus : parserCode === "PAYLOAD_TOO_LARGE" ? 413 : parserCode ? 400 : 503)
      .json({ error: { code: error instanceof CampusError ? error.code : parserCode ?? "SERVICE_UNAVAILABLE" } });
  };
  router.use(fail); return router;
}
