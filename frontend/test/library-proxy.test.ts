import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import type { RequestListener } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LIBRARY_REQUEST_BODY_LIMIT_BYTES } from "@intracampus/network";

type ExpressRequest = {
  method: string;
  path: string;
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  body: Record<string, unknown> | undefined;
  get(name: string): string | undefined;
};

type ExpressResponse = {
  set(field: string, value: string): ExpressResponse;
  status(code: number): ExpressResponse;
  json(body: unknown): ExpressResponse;
};

type ExpressNext = (error?: unknown) => void;
type ExpressHandler = (req: ExpressRequest, res: ExpressResponse, next: ExpressNext) => unknown;
type ExpressErrorHandler = (error: unknown, req: ExpressRequest, res: ExpressResponse, next: ExpressNext) => unknown;

type ExpressApp = RequestListener & {
  disable(setting: string): void;
  use(handler: unknown): void;
  get(path: string, ...handlers: ExpressHandler[]): void;
  post(path: string, ...handlers: ExpressHandler[]): void;
};

type ExpressModule = (() => ExpressApp) & {
  json(options: { limit: number | string }): ExpressHandler;
};

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const frontendDir = join(repoRoot, "frontend");
const backendPackageJson = join(repoRoot, "backend", "package.json");
const requireFromBackend = createRequire(backendPackageJson);
const express = requireFromBackend("express") as ExpressModule;

type RequestRecord = {
  method: string;
  url: string;
  origin: string | undefined;
  cookie: string | undefined;
  forwardedHost: string | undefined;
  body: unknown;
};

async function allocateLoopbackPort(): Promise<number> {
  const probe = createNetServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function childEnvironment(backendOrigin: string): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    NODE_ENV: "development",
    BACKEND_URL: backendOrigin,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(path|systemroot|windir|comspec|temp|tmp|localappdata|appdata|userprofile|home|programfiles.*|number_of_processors|processor_architecture)$/i.test(key)) {
      env[key] = value;
    }
  }
  return env as NodeJS.ProcessEnv;
}

function stopProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process already exited.
  }
}

async function startNextDev(t: TestContext, nextPort: number, backendOrigin: string): Promise<string> {
  const nextBin = join(frontendDir, "node_modules", "next", "dist", "bin", "next");
  const output: string[] = [];
  const child = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(nextPort)], {
    cwd: frontendDir,
    env: childEnvironment(backendOrigin),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    output.push(chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output.push(chunk.toString("utf8"));
  });

  let exitReason: string | null = null;
  child.once("exit", (code, signal) => {
    exitReason = `code=${code ?? "null"} signal=${signal ?? "null"}`;
  });

  t.after(async () => {
    stopProcessTree(child.pid);
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([once(child, "exit"), delay(3000)]);
    }
  });

  const nextOrigin = `http://127.0.0.1:${nextPort}`;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (exitReason !== null) {
      throw new Error(`next dev exited before becoming ready (${exitReason}):\n${output.join("")}`);
    }
    try {
      const probe = await fetch(`${nextOrigin}/api/deployment`);
      await probe.arrayBuffer();
      if (probe.status === 200 || probe.status === 503) {
        return nextOrigin;
      }
    } catch {
      // Server not listening yet.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for next dev at ${nextOrigin}:\n${output.join("")}`);
}

function cookiePairFromSetCookie(setCookies: string[], name: string): string {
  const match = setCookies.find((header) => header.startsWith(`${name}=`));
  assert.ok(match, `Expected Set-Cookie for ${name}, got: ${JSON.stringify(setCookies)}`);
  const [pair] = match.split(";");
  return pair;
}

test("Next same-origin proxy preserves auth cookies, headers, query, JSON bodies, and existing invoice/grants routes", async (t) => {
  const [{ Wallet }, { AuthService }, { AuthRepository }, { createAuthRouter }, { LibraryRepository }] = await Promise.all([
    import(pathToFileURL(join(repoRoot, "node_modules", "ethers", "lib.esm", "index.js")).href).catch(() =>
      import(pathToFileURL(join(repoRoot, "backend", "node_modules", "ethers", "lib.esm", "index.js")).href)),
    import(pathToFileURL(join(repoRoot, "backend", "src", "modules", "auth", "auth.service.ts")).href),
    import(pathToFileURL(join(repoRoot, "backend", "src", "modules", "auth", "auth.repository.ts")).href),
    import(pathToFileURL(join(repoRoot, "backend", "src", "modules", "auth", "auth.routes.ts")).href),
    import(pathToFileURL(join(repoRoot, "backend", "src", "modules", "library", "library.repository.ts")).href),
  ]);

  const student = new Wallet(`0x${"11".repeat(32)}`);
  const librarian = new Wallet(`0x${"33".repeat(32)}`);
  const bookId = `0x${"ab".repeat(32)}`;
  const requestId = `0x${"cd".repeat(32)}`;
  const txHash = `0x${"ef".repeat(32)}`;
  const invoiceId = `0x${"12".repeat(32)}`;

  const nextPort = await allocateLoopbackPort();
  const nextOrigin = `http://127.0.0.1:${nextPort}`;

  const repository = new LibraryRepository(":memory:");
  t.after(() => repository.close());
  repository.seedDemo({
    version: 1,
    books: [
      {
        bookId,
        title: "Distributed Systems",
        author: "A. Author",
        isbn: "9780000000001",
        depositWei: "50000000000000000000",
        replacementPriceWei: "30000000000000000000",
        copies: [{ copyId: "copy-1", barcode: "LIB-001" }],
      },
    ],
    accounts: [
      { wallet: student.address, role: "STUDENT" },
      { wallet: librarian.address, role: "LIBRARIAN" },
    ],
  });

  const authConfig = {
    origin: nextOrigin,
    domain: `127.0.0.1:${nextPort}`,
    chainId: 20261 as const,
    challengeTtlSeconds: 300,
    sessionTtlSeconds: 3600,
    challengeRateLimit: { maxRequests: 20, windowSeconds: 60 },
    verifyRateLimit: { maxRequests: 20, windowSeconds: 60 },
    cookieName: "library_session",
    secureCookie: false,
  };
  const authService = new AuthService(new AuthRepository(repository), authConfig);

  const recorded: RequestRecord[] = [];
  const app = express();
  app.disable("x-powered-by");

  // Record every proxied call as Express sees it before route parsing.
  app.use(((req: ExpressRequest, _res: ExpressResponse, next: ExpressNext) => {
    recorded.push({
      method: req.method,
      url: req.originalUrl,
      origin: req.get("origin"),
      cookie: req.get("cookie"),
      forwardedHost: req.get("x-forwarded-host"),
      body: undefined,
    });
    next();
  }) as ExpressHandler);

  app.use(createAuthRouter(authService, authConfig));

  const jsonParser = express.json({ limit: LIBRARY_REQUEST_BODY_LIMIT_BYTES });
  const requireSession = (req: ExpressRequest) => {
    const cookieHeader = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
    const match = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${authConfig.cookieName}=`));
    const token = match ? match.slice(authConfig.cookieName.length + 1) : undefined;
    return authService.session(token);
  };
  const requireSameOrigin: ExpressHandler = (req, res, next) => {
    if (req.get("origin") !== nextOrigin) {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "Origin mismatch", retryable: false } });
    }
    next();
  };
  const requireAuth = (
    req: ExpressRequest,
    res: ExpressResponse,
  ): { wallet: string; role: string } | null => {
    const session = requireSession(req);
    if (!session) {
      res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Auth required", retryable: false } });
      return null;
    }
    return session.account;
  };

  app.get("/api/library/books", (req, res) => {
    const account = requireAuth(req, res);
    if (!account) return;
    res.set("Cache-Control", "no-store").json({
      caller: account,
      q: req.query.q ?? null,
      books: [{ bookId, title: "Distributed Systems" }],
    });
  });

  app.get("/api/library/requests", (req, res) => {
    const account = requireAuth(req, res);
    if (!account) return;
    res.set("Cache-Control", "no-store").json({
      caller: account,
      queue: req.query.queue ?? null,
      requests: [],
    });
  });

  app.post("/api/library/requests", requireSameOrigin, jsonParser, (req, res) => {
    const account = requireAuth(req, res);
    if (!account) return;
    recorded[recorded.length - 1].body = req.body;
    if (req.body?.idempotencyKey === "conflict-key") {
      return res.status(409).json({ error: { code: "CONFLICT", message: "Idempotency mismatch", retryable: false } });
    }
    return res.status(201).json({
      requestId,
      bookId: req.body?.bookId,
      idempotencyKey: req.body?.idempotencyKey,
      borrower: account.wallet,
      status: "AWAITING_DEPOSIT",
    });
  });

  app.get("/api/library/requests/:requestId", (req, res) => {
    const account = requireAuth(req, res);
    if (!account) return;
    res.json({ requestId: req.params.requestId, borrower: account.wallet });
  });

  app.post("/api/library/requests/:requestId/transactions", requireSameOrigin, jsonParser, (req, res) => {
    const account = requireAuth(req, res);
    if (!account) return;
    recorded[recorded.length - 1].body = req.body;
    res.status(202).json({
      requestId: req.params.requestId,
      action: req.body?.action,
      txHash: req.body?.txHash,
      status: "SUBMITTED",
    });
  });

  app.get("/api/library/loans", (req, res) => {
    const account = requireAuth(req, res);
    if (!account) return;
    res.json({ borrowerWallet: req.query.borrowerWallet ?? null, loans: [] });
  });

  app.post("/api/library/loans/:loanId/return-requests", requireSameOrigin, jsonParser, (req, res) => {
    const account = requireAuth(req, res);
    if (!account) return;
    res.status(200).json({ loanId: req.params.loanId, status: "RETURN_REQUESTED" });
  });

  app.post("/api/library/loans/:loanId/settlement-intents", requireSameOrigin, jsonParser, (req, res) => {
    const account = requireAuth(req, res);
    if (!account) return;
    recorded[recorded.length - 1].body = req.body;
    res.status(201).json({
      intentId: "intent-1",
      loanId: req.params.loanId,
      outcome: req.body?.outcome,
      condition: req.body?.condition,
      reason: req.body?.reason,
      repairRequestedWei: req.body?.repairRequestedWei,
    });
  });

  app.get("/api/library/account-status", (req, res) => {
    const account = requireAuth(req, res);
    if (!account) return;
    if (req.query.simulate === "stale") {
      return res.set("Retry-After", "5").status(503).json({
        error: { code: "STALE_CHAIN_STATE", message: "Chain state stale", retryable: true },
      });
    }
    res.json({ account, holdActive: false });
  });

  const libraryErrorHandler: ExpressErrorHandler = (error, req, res, next) => {
    if (!req.path.startsWith("/api/library/")) return next(error);
    if (error && typeof error === "object" && "type" in error && error.type === "entity.too.large") {
      return res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Body limit exceeded", retryable: false } });
    }
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid JSON", retryable: false } });
  };
  app.use(libraryErrorHandler);

  app.post("/api/invoices", express.json({ limit: "8kb" }), (req, res) => {
    recorded[recorded.length - 1].body = req.body;
    res.status(201).json({ invoiceId, merchantId: req.body?.merchantId, serviceId: req.body?.serviceId });
  });

  app.get("/api/invoices/:invoiceId", (req, res) => {
    res.status(200).json({ invoiceId: req.params.invoiceId, txHash: req.query.txHash ?? null, status: "paid" });
  });

  app.get("/api/grants/:beneficiary", (req, res) => {
    res.status(200).json({ beneficiary: req.params.beneficiary, txHash: req.query.txHash ?? null, balanceWei: "4000000000000000000000" });
  });

  const backendServer = createHttpServer(app).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => {
    backendServer.close(() => resolve());
  }));
  await once(backendServer, "listening");
  const backendAddr = backendServer.address();
  assert.ok(backendAddr && typeof backendAddr !== "string");
  const backendOrigin = `http://127.0.0.1:${backendAddr.port}`;

  // Every client fetch below targets Next only (never backendOrigin directly).
  const activeNextOrigin = await startNextDev(t, nextPort, backendOrigin);
  assert.equal(activeNextOrigin, nextOrigin);

  const callNext = async (path: string, init: RequestInit = {}) => {
    const url = `${nextOrigin}${path}`;
    assert.equal(new URL(url).origin, nextOrigin);
    assert.notEqual(new URL(url).origin, backendOrigin);
    return fetch(url, init);
  };

  // 1. Unauthenticated /api/auth/session fails closed with 401 and no-store.
  const preSession = await callNext("/api/auth/session");
  assert.equal(preSession.status, 401);
  assert.match(preSession.headers.get("cache-control") ?? "", /\bno-store\b/i);
  assert.equal((await preSession.json()).error.code, "UNAUTHENTICATED");

  // 2. Cross-origin POST through Next is rejected by backend Origin check (Next preserves Origin, does not spoof backend origin).
  const badOriginChallenge = await callNext("/api/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://evil.example" },
    body: JSON.stringify({ wallet: student.address }),
  });
  assert.equal(badOriginChallenge.status, 403);
  assert.match(badOriginChallenge.headers.get("cache-control") ?? "", /\bno-store\b/i);

  // 3. Same-origin challenge -> sign -> verify -> Set-Cookie -> session -> logout round trip via Next.
  const challengeRes = await callNext("/api/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json", origin: nextOrigin },
    body: JSON.stringify({ wallet: student.address }),
  });
  assert.equal(challengeRes.status, 201);
  assert.match(challengeRes.headers.get("cache-control") ?? "", /\bno-store\b/i);
  const challenge = await challengeRes.json() as { challengeId: string; message: string; expiresAt: number };
  assert.ok(challenge.message.includes(`URI: ${nextOrigin}`));

  const signature = await student.signMessage(challenge.message);
  const verifyRes = await callNext("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json", origin: nextOrigin },
    body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
  });
  assert.equal(verifyRes.status, 200);
  assert.match(verifyRes.headers.get("cache-control") ?? "", /\bno-store\b/i);

  const setCookies = verifyRes.headers.getSetCookie();
  assert.equal(setCookies.length, 1);
  assert.match(setCookies[0], /\bHttpOnly\b/i);
  assert.match(setCookies[0], /\bSameSite=Strict\b/i);
  assert.match(setCookies[0], /\bPath=\//i);
  assert.doesNotMatch(setCookies[0], /\bDomain=/i);
  const sessionCookie = cookiePairFromSetCookie(setCookies, authConfig.cookieName);

  const verifyBody = await verifyRes.json() as { account: { wallet: string; role: string }; expiresAt: number };
  assert.deepEqual(verifyBody.account, { wallet: student.address.toLowerCase(), role: "STUDENT" });

  // 4. Session check carries cookie back through Next to Express.
  const sessionRes = await callNext("/api/auth/session", {
    headers: { cookie: sessionCookie },
  });
  assert.equal(sessionRes.status, 200);
  assert.match(sessionRes.headers.get("cache-control") ?? "", /\bno-store\b/i);
  const sessionBody = await sessionRes.json() as { account: { wallet: string; role: string } };
  assert.deepEqual(sessionBody.account, { wallet: student.address.toLowerCase(), role: "STUDENT" });

  // 5. Library read + query + write JSON body + nested paths + boundary + status/Retry-After pass-through with session cookie.
  const booksRes = await callNext("/api/library/books?q=Distributed%20Systems", {
    headers: { cookie: sessionCookie },
  });
  assert.equal(booksRes.status, 200);
  const booksBody = await booksRes.json() as { caller: { wallet: string }; q: string; books: Array<{ bookId: string }> };
  assert.equal(booksBody.caller.wallet, student.address.toLowerCase());
  assert.equal(booksBody.q, "Distributed Systems");
  assert.equal(booksBody.books[0].bookId, bookId);

  const createRequestRes = await callNext("/api/library/requests", {
    method: "POST",
    headers: { "content-type": "application/json", origin: nextOrigin, cookie: sessionCookie },
    body: JSON.stringify({ bookId, idempotencyKey: "req-idem-1" }),
  });
  assert.equal(createRequestRes.status, 201);
  const createdRequest = await createRequestRes.json() as { requestId: string; idempotencyKey: string; borrower: string };
  assert.equal(createdRequest.requestId, requestId);
  assert.equal(createdRequest.idempotencyKey, "req-idem-1");
  assert.equal(createdRequest.borrower, student.address.toLowerCase());

  const conflictRes = await callNext("/api/library/requests", {
    method: "POST",
    headers: { "content-type": "application/json", origin: nextOrigin, cookie: sessionCookie },
    body: JSON.stringify({ bookId, idempotencyKey: "conflict-key" }),
  });
  assert.equal(conflictRes.status, 409);
  assert.equal((await conflictRes.json()).error.code, "CONFLICT");

  // Exact 8192-byte JSON payload reaches Express (201); 8193-byte payload returns 413 PAYLOAD_TOO_LARGE.
  const prefix = `{"bookId":"${bookId}","idempotencyKey":"`;
  const suffix = '"}';
  const maxBody = `${prefix}${"a".repeat(LIBRARY_REQUEST_BODY_LIMIT_BYTES - prefix.length - suffix.length)}${suffix}`;
  assert.equal(Buffer.byteLength(maxBody, "utf8"), LIBRARY_REQUEST_BODY_LIMIT_BYTES);
  const maxBodyRes = await callNext("/api/library/requests", {
    method: "POST",
    headers: { "content-type": "application/json", origin: nextOrigin, cookie: sessionCookie },
    body: maxBody,
  });
  assert.equal(maxBodyRes.status, 201);
  assert.equal((await maxBodyRes.json()).bookId, bookId);

  const oversized = `${prefix}${"a".repeat(LIBRARY_REQUEST_BODY_LIMIT_BYTES + 1 - prefix.length - suffix.length)}${suffix}`;
  assert.equal(Buffer.byteLength(oversized, "utf8"), LIBRARY_REQUEST_BODY_LIMIT_BYTES + 1);
  const tooLargeRes = await callNext("/api/library/requests", {
    method: "POST",
    headers: { "content-type": "application/json", origin: nextOrigin, cookie: sessionCookie },
    body: oversized,
  });
  assert.equal(tooLargeRes.status, 413);
  assert.equal((await tooLargeRes.json()).error.code, "PAYLOAD_TOO_LARGE");

  const queueRes = await callNext("/api/library/requests?queue=true", {
    headers: { cookie: sessionCookie },
  });
  assert.equal(queueRes.status, 200);
  assert.equal((await queueRes.json()).queue, "true");

  const reqDetailRes = await callNext(`/api/library/requests/${requestId}`, {
    headers: { cookie: sessionCookie },
  });
  assert.equal(reqDetailRes.status, 200);
  assert.equal((await reqDetailRes.json()).requestId, requestId);

  const txSubmitRes = await callNext(`/api/library/requests/${requestId}/transactions`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: nextOrigin, cookie: sessionCookie },
    body: JSON.stringify({ action: "deposit", txHash }),
  });
  assert.equal(txSubmitRes.status, 202);
  assert.deepEqual(await txSubmitRes.json(), { requestId, action: "deposit", txHash, status: "SUBMITTED" });

  const loansRes = await callNext(`/api/library/loans?borrowerWallet=${student.address}`, {
    headers: { cookie: sessionCookie },
  });
  assert.equal(loansRes.status, 200);
  assert.equal((await loansRes.json()).borrowerWallet, student.address);

  const returnReqRes = await callNext(`/api/library/loans/${requestId}/return-requests`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: nextOrigin, cookie: sessionCookie },
    body: JSON.stringify({}),
  });
  assert.equal(returnReqRes.status, 200);
  assert.equal((await returnReqRes.json()).status, "RETURN_REQUESTED");

  const settleIntentRes = await callNext(`/api/library/loans/${requestId}/settlement-intents`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: nextOrigin, cookie: sessionCookie },
    body: JSON.stringify({ outcome: "RETURNED", condition: "GOOD", reason: "Clean copy", repairRequestedWei: "0" }),
  });
  assert.equal(settleIntentRes.status, 201);
  assert.equal((await settleIntentRes.json()).reason, "Clean copy");

  const accountStatusRes = await callNext("/api/library/account-status", {
    headers: { cookie: sessionCookie },
  });
  assert.equal(accountStatusRes.status, 200);
  assert.equal((await accountStatusRes.json()).account.wallet, student.address.toLowerCase());

  const staleStatusRes = await callNext("/api/library/account-status?simulate=stale", {
    headers: { cookie: sessionCookie },
  });
  assert.equal(staleStatusRes.status, 503);
  assert.equal(staleStatusRes.headers.get("retry-after"), "5");
  assert.equal((await staleStatusRes.json()).error.code, "STALE_CHAIN_STATE");

  // 6. Existing Invoice and Grants rewrites remain intact through Next.
  const createInvoiceRes = await callNext("/api/invoices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ merchantId: "parking-demo", serviceId: "parking-single" }),
  });
  assert.equal(createInvoiceRes.status, 201);
  assert.deepEqual(await createInvoiceRes.json(), {
    invoiceId,
    merchantId: "parking-demo",
    serviceId: "parking-single",
  });

  const getInvoiceRes = await callNext(`/api/invoices/${invoiceId}?txHash=${txHash}`);
  assert.equal(getInvoiceRes.status, 200);
  assert.deepEqual(await getInvoiceRes.json(), { invoiceId, txHash, status: "paid" });

  const getGrantRes = await callNext(`/api/grants/${student.address}?txHash=${txHash}`);
  assert.equal(getGrantRes.status, 200);
  assert.deepEqual(await getGrantRes.json(), {
    beneficiary: student.address,
    txHash,
    balanceWei: "4000000000000000000000",
  });

  // 7. Cross-origin logout is rejected without clearing session; same-origin logout revokes session and clears cookie.
  const badOriginLogout = await callNext("/api/auth/logout", {
    method: "POST",
    headers: { origin: "http://evil.example", cookie: sessionCookie },
  });
  assert.equal(badOriginLogout.status, 403);
  assert.match(badOriginLogout.headers.get("cache-control") ?? "", /\bno-store\b/i);

  const stillActiveSession = await callNext("/api/auth/session", {
    headers: { cookie: sessionCookie },
  });
  assert.equal(stillActiveSession.status, 200);
  await stillActiveSession.arrayBuffer();

  const logoutRes = await callNext("/api/auth/logout", {
    method: "POST",
    headers: { origin: nextOrigin, cookie: sessionCookie },
  });
  assert.equal(logoutRes.status, 204);
  assert.match(logoutRes.headers.get("cache-control") ?? "", /\bno-store\b/i);
  const clearedCookies = logoutRes.headers.getSetCookie();
  assert.equal(clearedCookies.length, 1);
  assert.match(clearedCookies[0], /^library_session=;/);
  assert.match(clearedCookies[0], /\bMax-Age=0\b/i);

  const postLogoutSession = await callNext("/api/auth/session", {
    headers: { cookie: sessionCookie },
  });
  assert.equal(postLogoutSession.status, 401);
  assert.match(postLogoutSession.headers.get("cache-control") ?? "", /\bno-store\b/i);
  assert.equal((await postLogoutSession.json()).error.code, "UNAUTHENTICATED");

  // Confirm Express saw same-origin forwarded host and preserved headers across the Next proxy,
  // and Next-owned routes were not sent to Express.
  const sessionChecks = recorded.filter((entry) => entry.url === "/api/auth/session");
  assert.equal(sessionChecks.length, 4);
  assert.equal(sessionChecks[1].cookie, sessionCookie);
  assert.equal(sessionChecks[1].forwardedHost, `127.0.0.1:${nextPort}`);
  const booksCall = recorded.find((entry) => entry.url.startsWith("/api/library/books"));
  assert.equal(booksCall?.url, "/api/library/books?q=Distributed%20Systems");
  assert.equal(booksCall?.cookie, sessionCookie);
  assert.ok(recorded.every((entry) => !entry.url.startsWith("/api/deployment")));
});

test("Next same-origin calls the real Express Library API with its session cookie", async (t) => {
  const [{ Wallet, Interface, keccak256 }, { AuthService }, { AuthRepository }, { LibraryRepository },
    { LibraryService }, { createApp }] = await Promise.all([
    import(pathToFileURL(join(repoRoot, "node_modules", "ethers", "lib.esm", "index.js")).href).catch(() =>
      import(pathToFileURL(join(repoRoot, "backend", "node_modules", "ethers", "lib.esm", "index.js")).href)),
    import(pathToFileURL(join(repoRoot, "backend", "src", "modules", "auth", "auth.service.ts")).href),
    import(pathToFileURL(join(repoRoot, "backend", "src", "modules", "auth", "auth.repository.ts")).href),
    import(pathToFileURL(join(repoRoot, "backend", "src", "modules", "library", "library.repository.ts")).href),
    import(pathToFileURL(join(repoRoot, "backend", "src", "modules", "library", "library.service.ts")).href),
    import(pathToFileURL(join(repoRoot, "backend", "src", "app.ts")).href),
  ]);

  const fixture = JSON.parse(readFileSync(join(repoRoot, "docs", "fixtures", "library-v1.json"), "utf8")) as {
    abi: unknown[];
    policy: {
      depositWei: string;
      approvalWindowSeconds: number;
      loanDurationSeconds: number;
      gracePeriodSeconds: number;
      lateFeeIntervalSeconds: number;
      lateFeePerIntervalWei: string;
      maxLateFeeWei: string;
      fullDepositRetentionAfterSeconds: number;
    };
  };
  const student = new Wallet(`0x${"71".repeat(32)}`);
  const librarian = new Wallet(`0x${"72".repeat(32)}`);
  const bookId = `0x${"73".repeat(32)}`;
  const escrow = `0x${"74".repeat(20)}`;
  const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  const chainTime = 1_800_000_000;
  const termsInterface = new Interface(fixture.abi as never);
  const library = {
    schemaVersion: 1,
    status: "deployed",
    chainId: 20261,
    abiVersion: 1,
    environment: "local-anvil",
    verifiedAt: { blockNumber: 4, blockHash: hash(4) },
    escrow: { address: escrow, transactionHash: hash(1), blockNumber: 1, blockHash: hash(1),
      runtimeCodeHash: keccak256("0x6000"), abiVersion: 1, abi: fixture.abi },
    roles: { deployer: address(11), administrator: address(12), librarian: librarian.address.toLowerCase() },
    treasury: address(13),
    policy: fixture.policy,
    books: [{ bookId, depositWei: fixture.policy.depositWei, replacementPriceWei: "30000000000000000000", sealed: true }],
    seedTransactions: [
      { type: "seedBookTerms", bookId, transactionHash: hash(2), blockNumber: 2, blockHash: hash(2) },
      { type: "sealBookTerms", bookId, transactionHash: hash(3), blockNumber: 3, blockHash: hash(3) },
    ],
  };
  const repository = new LibraryRepository(":memory:");
  repository.seedDemo({ version: 1, books: [{ bookId, title: "Proxy integrated book", author: "Test author", isbn: null,
    depositWei: fixture.policy.depositWei, replacementPriceWei: "30000000000000000000",
    copies: [{ copyId: "proxy-copy", barcode: "LP-001" }] }],
    accounts: [{ wallet: student.address, role: "STUDENT" }, { wallet: librarian.address, role: "LIBRARIAN" }] });
  t.after(() => repository.close());

  const nextPort = await allocateLoopbackPort();
  const nextOrigin = `http://127.0.0.1:${nextPort}`;
  const authConfig = {
    origin: nextOrigin,
    domain: `127.0.0.1:${nextPort}`,
    chainId: 20261 as const,
    challengeTtlSeconds: 300,
    sessionTtlSeconds: 3600,
    challengeRateLimit: { maxRequests: 10, windowSeconds: 60 },
    verifyRateLimit: { maxRequests: 10, windowSeconds: 60 },
    cookieName: "library_session",
    secureCookie: false,
  };
  const authService = new AuthService(new AuthRepository(repository), authConfig, () => chainTime);
  const rpc = {
    async getNetwork() { return { chainId: BigInt(20261) }; },
    async getBlock(tag: "latest" | number) {
      const number = tag === "latest" ? 500 : tag;
      return { number, timestamp: chainTime, hash: hash(number) };
    },
    async getLogs() { return []; },
    async getTransaction() { return null; },
    async getTransactionReceipt() { return null; },
    async getCode() { return "0x6000"; },
    async call() {
      return termsInterface.encodeFunctionResult("bookTerms", [fixture.policy.depositWei, "30000000000000000000", true]);
    },
  };
  const libraryService = new LibraryService(repository, {
    deployment: { schemaVersion: 1, status: "deployed", chainId: 20261, abiVersion: 1, environment: "local-anvil", library },
    allowLocal: true,
    chainFreshness: { maxStaleSeconds: 300, maxFutureDriftSeconds: 30, minConfirmations: 1 },
    rpc: rpc as never,
    now: () => chainTime,
  });
  t.after(() => libraryService.close());
  const api = createApp(undefined, undefined, undefined, undefined, authService, authConfig, libraryService);
  const backendServer = createHttpServer(api).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => backendServer.close(() => resolve())));
  await once(backendServer, "listening");
  const backendAddress = backendServer.address();
  assert.ok(backendAddress && typeof backendAddress !== "string");
  const origin = await startNextDev(t, nextPort, `http://127.0.0.1:${backendAddress.port}`);
  assert.equal(origin, nextOrigin);

  const challengeResponse = await fetch(`${origin}/api/auth/challenge`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ wallet: student.address }),
  });
  assert.equal(challengeResponse.status, 201);
  const challenge = await challengeResponse.json() as { challengeId: string; message: string };
  const verifyResponse = await fetch(`${origin}/api/auth/verify`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId, signature: await student.signMessage(challenge.message) }),
  });
  assert.equal(verifyResponse.status, 200);
  const cookie = cookiePairFromSetCookie(verifyResponse.headers.getSetCookie(), "library_session");

  const booksResponse = await fetch(`${origin}/api/library/books`, { headers: { cookie } });
  assert.equal(booksResponse.status, 200);
  assert.equal((await booksResponse.json() as Array<{ bookId: string; title: string }>)[0].title, "Proxy integrated book");

  const requestResponse = await fetch(`${origin}/api/library/requests`, {
    method: "POST",
    headers: { origin, cookie, "content-type": "application/json" },
    body: JSON.stringify({ bookId, idempotencyKey: "next-real-api-request" }),
  });
  assert.equal(requestResponse.status, 201);
  const request = await requestResponse.json() as { requestId: string; status: string; depositIntent: { valueWei: string } };
  assert.equal(request.status, "AWAITING_DEPOSIT");
  assert.equal(request.depositIntent.valueWei, fixture.policy.depositWei);
  assert.equal(repository.getRequest(request.requestId)?.wallet, student.address.toLowerCase());
  assert.equal(repository.getRequest(request.requestId)?.status, "AWAITING_DEPOSIT");
});
