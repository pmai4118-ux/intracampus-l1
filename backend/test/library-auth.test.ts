import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { Wallet } from "ethers";
import { AuthError, AuthService } from "../src/modules/auth/auth.service.ts";
import { AuthRepository } from "../src/modules/auth/auth.repository.ts";
import { readLibraryAuthConfig, type LibraryAuthConfig } from "../src/modules/auth/auth.config.ts";
import { createAuthRouter } from "../src/modules/auth/auth.routes.ts";
import { LibraryRepository } from "../src/modules/library/library.repository.ts";
import type { LibraryDemoSeed } from "../src/modules/library/library.types.ts";

const student = new Wallet(`0x${"11".repeat(32)}`);
const other = new Wallet(`0x${"22".repeat(32)}`);
const librarian = new Wallet(`0x${"33".repeat(32)}`);
const outsider = new Wallet(`0x${"44".repeat(32)}`);
const config: LibraryAuthConfig = {
  origin: "http://localhost:3000", domain: "localhost:3000", chainId: 20261,
  challengeTtlSeconds: 300, sessionTtlSeconds: 3600,
  challengeRateLimit: { maxRequests: 10, windowSeconds: 60 },
  verifyRateLimit: { maxRequests: 10, windowSeconds: 60 },
  cookieName: "library_session", secureCookie: false,
};
const seed: LibraryDemoSeed = {
  version: 1,
  books: [{ bookId: `0x${"ab".repeat(32)}`, title: "Demo", author: "Author", isbn: null,
    depositWei: "50000000000000000000", replacementPriceWei: "30000000000000000000",
    copies: [{ copyId: "c1", barcode: "LC-001" }] }],
  accounts: [
    { wallet: student.address, role: "STUDENT" },
    { wallet: other.address, role: "STUDENT" },
    { wallet: librarian.address, role: "LIBRARIAN" },
  ],
};

function setup(options: { now?: number; config?: LibraryAuthConfig } = {}) {
  let now = options.now ?? 1_800_000_000;
  const library = new LibraryRepository(":memory:");
  library.seedDemo(seed);
  const authRepository = new AuthRepository(library);
  const service = new AuthService(authRepository, options.config ?? config, () => now);
  return { library, authRepository, service, setNow: (value: number) => { now = value; } };
}

async function serve(t: TestContext, router: ReturnType<typeof createAuthRouter>): Promise<string> {
  const app = express();
  app.use(router);
  const server = createServer(app).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body) });
  const result = response.status === 204 ? null : await response.json();
  return { response, result };
}

test("allowlisted wallet signs the exact server-origin and chain-bound challenge to get a session", async (t) => {
  const state = setup();
  t.after(() => state.library.close());
  const challenge = state.service.createChallenge({ wallet: student.address, remoteAddress: "127.0.0.1" });
  assert.match(challenge.message, /^localhost:3000 wants you to sign in with your Ethereum account:/);
  assert.ok(challenge.message.includes(`URI: ${config.origin}`));
  assert.match(challenge.message, /Chain ID: 20261/);
  assert.match(challenge.message, /Nonce: [a-f0-9]{32}/);
  const signature = await student.signMessage(challenge.message);
  const session = state.service.verifyChallenge({ challengeId: challenge.challengeId, signature, remoteAddress: "127.0.0.1" });
  assert.deepEqual(session.account, { wallet: student.address.toLowerCase(), role: "STUDENT" });
  assert.equal(state.service.session(session.token)?.account.role, "STUDENT");
  assert.ok(!JSON.stringify(session.account).includes(signature));
  assert.equal(state.service.logout(session.token), true);
  assert.equal(state.service.session(session.token), undefined);
});

test("wrong-wallet and altered-domain or chain signatures do not consume the challenge", async (t) => {
  const state = setup();
  t.after(() => state.library.close());
  const challenge = state.service.createChallenge({ wallet: student.address, remoteAddress: "127.0.0.1" });
  const wrongWalletSignature = await other.signMessage(challenge.message);
  assert.throws(() => state.service.verifyChallenge({ challengeId: challenge.challengeId,
    signature: wrongWalletSignature, remoteAddress: "127.0.0.1" }), (error: unknown) => error instanceof AuthError && error.code === "UNAUTHENTICATED");
  assert.equal(state.authRepository.getChallenge(challenge.challengeId)?.consumedAt, null);

  const alteredDomain = challenge.message.replace("localhost:3000", "evil.example");
  const alteredDomainSignature = await student.signMessage(alteredDomain);
  assert.throws(() => state.service.verifyChallenge({ challengeId: challenge.challengeId,
    signature: alteredDomainSignature, remoteAddress: "127.0.0.1" }), (error: unknown) => error instanceof AuthError && error.code === "UNAUTHENTICATED");
  assert.equal(state.authRepository.getChallenge(challenge.challengeId)?.consumedAt, null);

  const alteredChain = challenge.message.replace("Chain ID: 20261", "Chain ID: 1");
  const alteredChainSignature = await student.signMessage(alteredChain);
  assert.throws(() => state.service.verifyChallenge({ challengeId: challenge.challengeId,
    signature: alteredChainSignature, remoteAddress: "127.0.0.1" }), (error: unknown) => error instanceof AuthError && error.code === "UNAUTHENTICATED");
  assert.equal(state.authRepository.getChallenge(challenge.challengeId)?.consumedAt, null);
});

test("expired challenge is rejected at its exact expiry second", async (t) => {
  const state = setup();
  t.after(() => state.library.close());
  const challenge = state.service.createChallenge({ wallet: student.address, remoteAddress: "127.0.0.1" });
  const signature = await student.signMessage(challenge.message);
  state.setNow(challenge.expiresAt);
  assert.throws(() => state.service.verifyChallenge({ challengeId: challenge.challengeId,
    signature, remoteAddress: "127.0.0.1" }), (error: unknown) => error instanceof AuthError && error.code === "UNAUTHENTICATED");
  assert.equal(state.authRepository.getChallenge(challenge.challengeId), undefined, "expired challenges are removed during auth maintenance");
});

test("TTL overflow after startup fails closed as a configuration error for challenge and session", async (t) => {
  const start = 1_800_000_000;
  const maximumTtl = 8_640_000_000_000 - start;
  const env = {
    LIBRARY_AUTH_ORIGIN: "https://campus.example.edu",
    LIBRARY_CHALLENGE_TTL_SECONDS: String(maximumTtl),
    LIBRARY_SESSION_TTL_SECONDS: String(maximumTtl),
    LIBRARY_CHALLENGE_RATE_LIMIT_MAX_REQUESTS: "10",
    LIBRARY_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS: "60",
    LIBRARY_VERIFY_RATE_LIMIT_MAX_REQUESTS: "10",
    LIBRARY_VERIFY_RATE_LIMIT_WINDOW_SECONDS: "60",
  };

  const challengeConfig = readLibraryAuthConfig(env, start);
  const challengeState = setup({ config: challengeConfig, now: start + 1 });
  t.after(() => challengeState.library.close());
  assert.throws(() => challengeState.service.createChallenge({ wallet: student.address, remoteAddress: "127.0.0.1" }),
    (error: unknown) => error instanceof AuthError && error.code === "CONFIGURATION_ERROR" && error.httpStatus === 503);

  const sessionConfig = readLibraryAuthConfig({ ...env, LIBRARY_CHALLENGE_TTL_SECONDS: "300" }, start);
  const sessionState = setup({ config: sessionConfig, now: start });
  t.after(() => sessionState.library.close());
  const challenge = sessionState.service.createChallenge({ wallet: student.address, remoteAddress: "127.0.0.2" });
  const signature = await student.signMessage(challenge.message);
  sessionState.setNow(start + 1);
  assert.throws(() => sessionState.service.verifyChallenge({ challengeId: challenge.challengeId, signature, remoteAddress: "127.0.0.2" }),
    (error: unknown) => error instanceof AuthError && error.code === "CONFIGURATION_ERROR" && error.httpStatus === 503);
  assert.equal(sessionState.authRepository.getChallenge(challenge.challengeId)?.consumedAt, null);
});

test("role and ownership are resolved from allowlist rather than request fields", async (t) => {
  const state = setup();
  t.after(() => state.library.close());
  assert.throws(() => state.service.createChallenge({ wallet: outsider.address, remoteAddress: "127.0.0.2" }),
    (error: unknown) => error instanceof AuthError && error.code === "UNAUTHENTICATED");
  const challenge = state.service.createChallenge({ wallet: student.address, role: "LIBRARIAN", remoteAddress: "127.0.0.1" } as never);
  const signature = await student.signMessage(challenge.message);
  assert.equal(state.service.verifyChallenge({ challengeId: challenge.challengeId, signature, remoteAddress: "127.0.0.1" }).account.role,
    "STUDENT");
});

test("configured auth rate limit returns retry timing without exposing storage identifiers", (t) => {
  const limited = { ...config,
    challengeRateLimit: { maxRequests: 1, windowSeconds: 60 },
    verifyRateLimit: { maxRequests: 1, windowSeconds: 60 },
  };
  const state = setup({ config: limited, now: 1_800_000_000 });
  t.after(() => state.library.close());
  assert.throws(() => state.service.createChallenge({ wallet: "malformed", remoteAddress: "127.0.0.1" }),
    (error: unknown) => error instanceof AuthError && error.code === "VALIDATION_ERROR");
  assert.throws(() => state.service.createChallenge({ wallet: student.address, remoteAddress: "127.0.0.1" }),
    (error: unknown) => error instanceof AuthError && error.code === "RATE_LIMITED" && error.httpStatus === 429 && error.retryAfterSeconds === 60);
});

test("HTTP auth round trip sets an opaque cookie, resolves allowlist session, and clears on logout", async (t) => {
  const state = setup();
  t.after(() => state.library.close());
  const baseUrl = await serve(t, createAuthRouter(state.service, config));
  const challengeResponse = await post(baseUrl, "/api/auth/challenge", { wallet: student.address }, { Origin: config.origin });
  assert.equal(challengeResponse.response.status, 201);
  assert.equal(challengeResponse.response.headers.get("cache-control"), "no-store");
  const challenge = challengeResponse.result as { challengeId: string; message: string; expiresAt: number };
  const signature = await student.signMessage(challenge.message);
  const verified = await post(baseUrl, "/api/auth/verify", { challengeId: challenge.challengeId, signature }, { Origin: config.origin });
  assert.equal(verified.response.status, 200);
  assert.deepEqual(verified.result && (verified.result as { account: unknown }).account,
    { wallet: student.address.toLowerCase(), role: "STUDENT" });
  assert.equal("token" in (verified.result as Record<string, unknown>), false);
  const setCookie = verified.response.headers.get("set-cookie");
  assert.ok(setCookie?.includes("library_session="));
  assert.ok(setCookie?.includes("HttpOnly; SameSite=Strict; Max-Age=3600"));
  assert.equal(setCookie?.includes("Secure"), false);
  const cookie = setCookie?.split(";", 1)[0];
  assert.ok(cookie);

  const session = await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: cookie } });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { account: { wallet: student.address.toLowerCase(), role: "STUDENT" }, expiresAt: 1_800_003_600 });
  assert.equal(session.headers.get("cache-control"), "no-store");

  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { Origin: config.origin, Cookie: cookie } });
  assert.equal(logout.status, 204);
  assert.ok(logout.headers.get("set-cookie")?.includes("Max-Age=0"));
  const afterLogout = await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: cookie } });
  assert.equal(afterLogout.status, 401);
});

test("HTTPS auth cookie has the __Host prefix and Secure attribute", async (t) => {
  const secureConfig = { ...config, origin: "https://campus.example.edu", domain: "campus.example.edu",
    cookieName: "__Host-library_session", secureCookie: true };
  const state = setup({ config: secureConfig });
  t.after(() => state.library.close());
  const baseUrl = await serve(t, createAuthRouter(state.service, secureConfig));
  const challengeResponse = await post(baseUrl, "/api/auth/challenge", { wallet: student.address }, { Origin: secureConfig.origin });
  const challenge = challengeResponse.result as { challengeId: string; message: string };
  const signature = await student.signMessage(challenge.message);
  const verified = await post(baseUrl, "/api/auth/verify", { challengeId: challenge.challengeId, signature }, { Origin: secureConfig.origin });
  assert.equal(verified.response.status, 200);
  const cookie = verified.response.headers.get("set-cookie");
  assert.ok(cookie?.startsWith("__Host-library_session="));
  assert.ok(cookie?.includes("Path=/; HttpOnly; SameSite=Strict; Max-Age=3600; Secure"));
  assert.equal(cookie?.toLowerCase().includes("domain="), false);
});

test("auth HTTP enforces Origin, public 429 Retry-After, and the 8 KiB body limit", async (t) => {
  const limited = { ...config,
    challengeRateLimit: { maxRequests: 1, windowSeconds: 60 },
    verifyRateLimit: { maxRequests: 1, windowSeconds: 60 },
  };
  const state = setup({ config: limited, now: 1_800_000_000 });
  t.after(() => state.library.close());
  const baseUrl = await serve(t, createAuthRouter(state.service, limited));
  const wrongOrigin = await post(baseUrl, "/api/auth/challenge", { wallet: student.address }, { Origin: "https://evil.example" });
  assert.equal(wrongOrigin.response.status, 403);
  assert.equal((wrongOrigin.result as { error: { code: string } }).error.code, "FORBIDDEN");

  const first = await post(baseUrl, "/api/auth/challenge", { wallet: student.address }, { Origin: limited.origin });
  assert.equal(first.response.status, 201);
  const throttled = await post(baseUrl, "/api/auth/challenge", { wallet: student.address }, { Origin: limited.origin });
  assert.equal(throttled.response.status, 429);
  assert.equal(throttled.response.headers.get("retry-after"), "60");
  assert.deepEqual(throttled.result, { error: {
    code: "RATE_LIMITED", message: "Too many authentication requests. Try again after the indicated delay.", retryable: true,
  } });

  const firstVerify = await post(baseUrl, "/api/auth/verify", { challengeId: "x".repeat(32), signature: `0x${"00".repeat(65)}` },
    { Origin: limited.origin });
  assert.equal(firstVerify.response.status, 401);
  const throttledVerify = await post(baseUrl, "/api/auth/verify", { challengeId: "x".repeat(32), signature: `0x${"00".repeat(65)}` },
    { Origin: limited.origin });
  assert.equal(throttledVerify.response.status, 429);
  assert.equal(throttledVerify.response.headers.get("retry-after"), "60");

  const large = await post(baseUrl, "/api/auth/verify", { challengeId: "x".repeat(32), signature: "0x", padding: "z".repeat(9000) },
    { Origin: limited.origin });
  assert.equal(large.response.status, 413);
  assert.equal((large.result as { error: { code: string } }).error.code, "PAYLOAD_TOO_LARGE");
});

test("auth endpoints fail closed when required auth configuration is unavailable", async (t) => {
  const baseUrl = await serve(t, createAuthRouter());
  const response = await post(baseUrl, "/api/auth/challenge", { wallet: student.address }, { Origin: config.origin });
  assert.equal(response.response.status, 503);
  assert.equal((response.result as { error: { code: string } }).error.code, "CONFIGURATION_ERROR");
});
