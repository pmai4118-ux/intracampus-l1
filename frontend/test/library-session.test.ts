import assert from "node:assert/strict";
import test from "node:test";
import { librarySessionMessage, LibrarySessionError, readLibraryStudentAccess, requireLibraryStudentNotHeld,
  signInLibraryStudent } from "../lib/library-session.ts";

const student = `0x${"11".repeat(20)}`;
const other = `0x${"22".repeat(20)}`;
const loanId = `0x${"ab".repeat(32)}`;
const session = (wallet = student, role = "STUDENT") => ({ account: { wallet, role }, expiresAt: 1_800_000_000 });
const status = (held = false) => ({ held, checkedAt: 1_799_999_999, blockingLoanIds: held ? [loanId] : [] });
const response = (body: unknown, statusCode = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status: statusCode, headers });

test("access read has no wallet prompt and requests same-origin session and account status", async () => {
  const paths: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    paths.push(String(input));
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.cache, "no-store");
    return String(input) === "/api/auth/session" ? response(session()) : response(status());
  };
  const access = await readLibraryStudentAccess(student, fetcher);
  assert.equal(access.status, "ready");
  assert.deepEqual(paths, ["/api/auth/session", "/api/library/account-status"]);
});

test("expired or absent session is an explicit sign-in state without fetching protected account data", async () => {
  const paths: string[] = [];
  const access = await readLibraryStudentAccess(student, async (input) => {
    paths.push(String(input)); return response({ error: { code: "UNAUTHENTICATED" } }, 401);
  });
  assert.deepEqual(access, { status: "sign-in-required", blockingLoanIds: [] });
  assert.deepEqual(paths, ["/api/auth/session"]);
});

test("explicit sign-in challenges, signs, verifies, then exposes the held loan IDs", async () => {
  const paths: string[] = [], signatures: Array<[string, string]> = [];
  let authenticated = false;
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input); paths.push(path);
    assert.equal(init?.credentials, "same-origin");
    if (path === "/api/auth/session") return authenticated ? response(session()) : response({}, 401);
    if (path === "/api/auth/challenge") {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { wallet: student });
      return response({ challengeId: "challenge-1", message: "Sign in to IntraCampus", expiresAt: 1_800_000_010 });
    }
    if (path === "/api/auth/verify") {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { challengeId: "challenge-1", signature: `0x${"cd".repeat(65)}` });
      authenticated = true;
      return response(session());
    }
    if (path === "/api/library/account-status") return response(status(true));
    assert.fail(`unexpected path ${path}`);
  };
  const access = await signInLibraryStudent(student, async (account, message) => {
    signatures.push([account, message]); return `0x${"cd".repeat(65)}`;
  }, fetcher);
  assert.equal(access.status, "held");
  if (access.status === "held") assert.deepEqual(access.accountStatus.blockingLoanIds, [loanId]);
  assert.deepEqual(signatures, [[student, "Sign in to IntraCampus"]]);
  assert.deepEqual(paths, ["/api/auth/session", "/api/auth/challenge", "/api/auth/verify", "/api/auth/session", "/api/library/account-status"]);
});

test("sign-in replaces a session from another wallet after a fresh explicit challenge", async () => {
  let signs = 0, authenticated = false;
  const result = await signInLibraryStudent(student, async () => { signs++; return `0x${"cd".repeat(65)}`; }, async (input) => {
    if (String(input) === "/api/auth/session") return response(session(authenticated ? student : other));
    if (String(input) === "/api/auth/challenge") return response({ challengeId: "c", message: "Sign", expiresAt: 2 });
    if (String(input) === "/api/auth/verify") { authenticated = true; return response(session()); }
    return response(status());
  });
  assert.equal(signs, 1, "a fresh challenge is signed only after the caller explicitly invokes sign-in");
  assert.equal(result.status, "ready");
});

test("fresh transaction guard blocks holds and preserves Retry-After errors", async () => {
  const heldFetcher: typeof fetch = async (input) => String(input) === "/api/auth/session"
    ? response(session()) : response(status(true));
  await assert.rejects(requireLibraryStudentNotHeld(student, heldFetcher), (error: unknown) =>
    error instanceof LibrarySessionError && error.code === "ACCOUNT_HELD");

  const limitedFetcher: typeof fetch = async () => response({ error: { code: "RATE_LIMITED" } }, 429, { "retry-after": "17" });
  await assert.rejects(readLibraryStudentAccess(student, limitedFetcher).then((access) => {
    if (access.status === "error") throw new LibrarySessionError(access.code);
  }), (error: unknown) => error instanceof LibrarySessionError && error.code === "RATE_LIMITED");
  assert.match(librarySessionMessage("RATE_LIMITED"), /Retry-After/);
});
