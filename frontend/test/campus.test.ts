import assert from "node:assert/strict";
import test from "node:test";
import { campusApi, campusLogin, validateCampusPayout } from "../lib/campus.ts";
import type { CampusPayout } from "@intracampus/network";
const from = `0x${"11".repeat(20)}`, wallet = `0x${"22".repeat(20)}`;
const p: CampusPayout = { id: "example", kind: "WELCOME", status: "PREPARED", wallet, from, to: wallet, value: `0x${(BigInt(20) * BigInt(10) ** BigInt(18)).toString(16)}`, data: "0x1234", afterBlock: 1, txHash: null };
test("welcome transaction preview binds exact 20 CAMPUS, signer and recipient", () => {
  assert.equal(validateCampusPayout(p, from).to, wallet);
  assert.throws(() => validateCampusPayout({ ...p, value: "0x1" }, from));
  assert.throws(() => validateCampusPayout({ ...p, to: from }, from));
  assert.throws(() => validateCampusPayout(p, wallet));
  assert.throws(() => validateCampusPayout({ ...p, data: "javascript:alert(1)" }, from));
});

test("logout accepts an empty 204 response", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  assert.equal(await campusApi("auth/logout", {}), undefined);
});

test("malformed and expired challenges never open the signing prompt", async t => {
  let calls = 0;
  for (const expiresAt of [undefined, "tomorrow", 1]) {
    const mocked = t.mock.method(globalThis, "fetch", async () => Response.json({ challengeId: "challenge", message: "Sign", expiresAt }));
    await assert.rejects(campusLogin(wallet, async () => { calls++; return "0x"; }), /INVALID_RESPONSE/);
    mocked.mock.restore();
  }
  assert.equal(calls, 0);
});
