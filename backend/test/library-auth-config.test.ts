import assert from "node:assert/strict";
import { test } from "node:test";
import { readLibraryAuthConfig } from "../src/modules/auth/auth.config.ts";

const base = {
  LIBRARY_AUTH_ORIGIN: "https://campus.example.edu",
  LIBRARY_CHALLENGE_TTL_SECONDS: "300",
  LIBRARY_SESSION_TTL_SECONDS: "3600",
  LIBRARY_CHALLENGE_RATE_LIMIT_MAX_REQUESTS: "10",
  LIBRARY_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS: "60",
  LIBRARY_VERIFY_RATE_LIMIT_MAX_REQUESTS: "8",
  LIBRARY_VERIFY_RATE_LIMIT_WINDOW_SECONDS: "60",
};

test("auth configuration derives trusted domain and secure host-only cookie from configured HTTPS origin", () => {
  assert.deepEqual(readLibraryAuthConfig(base), {
    origin: "https://campus.example.edu",
    domain: "campus.example.edu",
    chainId: 20261,
    challengeTtlSeconds: 300,
    sessionTtlSeconds: 3600,
    challengeRateLimit: { maxRequests: 10, windowSeconds: 60 },
    verifyRateLimit: { maxRequests: 8, windowSeconds: 60 },
    trustedProxyAddresses: ["127.0.0.1", "::1"],
    cookieName: "__Host-library_session",
    secureCookie: true,
  });
});

test("local HTTP auth requires explicit opt-in and production HTTP is rejected", () => {
  assert.throws(() => readLibraryAuthConfig({ ...base, LIBRARY_AUTH_ORIGIN: "http://localhost:3000" }), { message: "CONFIGURATION_ERROR" });
  assert.equal(readLibraryAuthConfig({ ...base, LIBRARY_AUTH_ORIGIN: "http://localhost:3000", LIBRARY_ALLOW_INSECURE_LOCALHOST: "true" }).secureCookie, false);
  assert.throws(() => readLibraryAuthConfig({ ...base, LIBRARY_AUTH_ORIGIN: "http://campus.example.edu", LIBRARY_ALLOW_INSECURE_LOCALHOST: "true" }),
    { message: "CONFIGURATION_ERROR" });
});

test("auth origin rejects paths, credentials, and missing or invalid fail-closed settings", () => {
  for (const origin of ["https://user:secret@campus.example.edu", "https://campus.example.edu/library", "https://campus.example.edu?x=1"]) {
    assert.throws(() => readLibraryAuthConfig({ ...base, LIBRARY_AUTH_ORIGIN: origin }), { message: "CONFIGURATION_ERROR" });
  }
  for (const name of Object.keys(base)) {
    assert.throws(() => readLibraryAuthConfig({ ...base, [name]: undefined }), { message: "CONFIGURATION_ERROR" });
  }
  assert.throws(() => readLibraryAuthConfig({ ...base, LIBRARY_SESSION_TTL_SECONDS: "1e6" }), { message: "CONFIGURATION_ERROR" });
  assert.throws(() => readLibraryAuthConfig({ ...base, LIBRARY_VERIFY_RATE_LIMIT_MAX_REQUESTS: "9007199254740992" }), { message: "CONFIGURATION_ERROR" });
  assert.throws(() => readLibraryAuthConfig({ ...base, LIBRARY_TRUSTED_PROXY_ADDRESSES: "localhost,127.0.0.1" }), { message: "CONFIGURATION_ERROR" });
  assert.deepEqual(readLibraryAuthConfig({ ...base, LIBRARY_TRUSTED_PROXY_ADDRESSES: "::ffff:127.0.0.1,127.0.0.1" }).trustedProxyAddresses,
    ["127.0.0.1"]);
});

test("auth TTLs stop at the largest expiry representable by the service", () => {
  const now = 1_800_000_000;
  const maximumTtl = 8_640_000_000_000 - now;
  assert.equal(readLibraryAuthConfig({ ...base, LIBRARY_CHALLENGE_TTL_SECONDS: String(maximumTtl),
    LIBRARY_SESSION_TTL_SECONDS: String(maximumTtl) }, now).challengeTtlSeconds, maximumTtl);
  assert.throws(() => readLibraryAuthConfig({ ...base, LIBRARY_CHALLENGE_TTL_SECONDS: String(maximumTtl + 1) }, now),
    { message: "CONFIGURATION_ERROR" });
  assert.throws(() => readLibraryAuthConfig({ ...base, LIBRARY_SESSION_TTL_SECONDS: String(maximumTtl + 1) }, now),
    { message: "CONFIGURATION_ERROR" });
});
