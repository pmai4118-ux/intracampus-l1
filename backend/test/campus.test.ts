import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import express from "express";
import { Wallet, Interface, keccak256 } from "ethers";
import { CampusRepository } from "../src/modules/campus/campus.repository.ts";
import { CampusService, welcomeWei } from "../src/modules/campus/campus.service.ts";
import { createCampusRouter } from "../src/modules/campus/campus.routes.ts";
import { LibraryRepository } from "../src/modules/library/library.repository.ts";
import { campusApi, releaseCampusPayout, sendCampusPayout, type CampusPayoutRecovery } from "../../frontend/lib/campus.ts";

const school = Wallet.createRandom(), student = Wallet.createRandom(), other = Wallet.createRandom();
const lower = (wallet: {address: string}) => wallet.address.toLowerCase();
const hash = `0x${"ab".repeat(32)}`, blockHash = `0x${"cd".repeat(32)}`;
const env = { CAMPUS_AUTH_ORIGIN: "http://localhost:3000", LIBRARY_ALLOW_INSECURE_LOCALHOST: "true",
  CAMPUS_SCHOOL_WALLETS: school.address, CAMPUS_TREASURY_ADDRESS: school.address };
const token = () => randomBytes(32).toString("hex");
const begin = (service: CampusService, id: string, actor = school.address, attemptToken = token()) => service.begin(id, actor, attemptToken);
function setup(chainId = 20261) {
  const repository = new CampusRepository(":memory:");
  const chainHex = `0x${BigInt(chainId).toString(16)}`;
  const state: { receipt: any; transaction: any; chain: string; unavailable: boolean; stale: boolean; reorg: boolean; estimateFails: boolean; beforeEstimate?: () => Promise<void> } =
    { receipt: null, transaction: null, chain: chainHex, unavailable: false, stale: false, reorg: false, estimateFails: false };
  const manifest = JSON.parse(readFileSync(new URL("../../docs/fixtures/b03-l05-l06-local.json", import.meta.url), "utf8")).manifest;
  manifest.environment = "avalanche-l1"; manifest.roles.grantIssuer = school.address;
  manifest.contracts.PurposeBoundGrantVault.runtimeCodeHash = keccak256("0x6000");
  const rpc = { async call(method: string, params: unknown[]): Promise<unknown> {
    if (state.unavailable) throw Error("RPC_UNAVAILABLE");
    if (method === "eth_chainId") return state.chain;
    if (method === "eth_getBlockByNumber") return { number: params[0] === "latest" ? state.receipt ? "0x65" : "0x64" : params[0], hash: state.reorg ? `0x${"ef".repeat(32)}` : blockHash,
      timestamp: `0x${(Math.floor(Date.now() / 1000) - (state.stale ? 1000 : 0)).toString(16)}` };
    if (method === "eth_getCode") return params[0] === lower(school) ? "0x" : "0x6000";
    if (method === "eth_call") return `0x${school.address.slice(2).toLowerCase().padStart(64, "0")}`;
    if (method === "eth_estimateGas") { await state.beforeEstimate?.(); if (state.estimateFails) throw Error("simulation failed"); return "0x5208"; }
    if (method === "eth_getTransactionReceipt") return state.receipt;
    if (method === "eth_getTransactionByHash") return state.transaction;
    throw Error(method);
  } };
  const service = new CampusService(repository, { ...env, NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID: String(chainId) }, rpc, manifest);
  const approve = () => { repository.submit(lower(student), "DEMO-1001", "CNTT"); repository.review(lower(school), lower(student), "STUDENT", true, "VERIFIED"); };
  const proof = (p: ReturnType<CampusRepository["payout"]>) => {
    state.receipt = { status: "0x1", transactionHash: hash, blockNumber: "0x65", blockHash, logs: [] };
    state.transaction = { hash, from: p.from, to: p.to, input: p.data, value: p.value, blockNumber: "0x65", blockHash: blockHash, chainId: chainHex };
  };
  return { repository, service, state, approve, proof };
}
test("wallet authentication does not approve a student; nonce replay, wrong signature and logout stay enforced", async () => {
  const { repository: r, service: s } = setup();
  try {
    const challenge = s.auth.createChallenge({ wallet: student.address, remoteAddress: "127.0.0.1" });
    assert.match(challenge.message, /does not verify student status or transfer funds/);
    const signature = await student.signMessage(challenge.message);
    assert.throws(() => s.auth.verifyChallenge({ challengeId: challenge.challengeId, signature: "0x" + "00".repeat(65), remoteAddress: "127.0.0.1" }));
    const verified = s.auth.verifyChallenge({ challengeId: challenge.challengeId, signature, remoteAddress: "127.0.0.1" });
    assert.equal(r.profile(lower(student)).application, null);
    assert.equal(s.auth.session(verified.token)?.account.wallet, student.address);
    assert.throws(() => s.auth.verifyChallenge({ challengeId: challenge.challengeId, signature, remoteAddress: "127.0.0.1" }));
    s.auth.logout(verified.token); assert.equal(s.auth.session(verified.token), undefined);
    for (let i = 0; i < 9; i++) s.auth.createChallenge({ wallet: student.address, remoteAddress: "127.0.0.1" });
    assert.throws(() => s.auth.createChallenge({ wallet: student.address, remoteAddress: "127.0.0.1" }), /RATE_LIMITED/);
  } finally { r.close(); }
});
test("Campus auth, payout preflight and receipt reconciliation use the configured cloud chain", async () => {
  const { repository, service, approve, proof } = setup(20261120);
  try {
    assert.equal(service.authConfig.chainId, 20261120);
    const challenge = service.auth.createChallenge({ wallet: school.address, remoteAddress: "127.0.0.1" });
    assert.match(challenge.message, /Chain ID: 20261120/);
    approve();
    const payout = await service.prepare(school.address, student.address, "WELCOME");
    await begin(service, payout.id);
    proof(payout);
    assert.equal((await service.reconcile(payout.id, hash)).status, "CONFIRMED");
  } finally { repository.close(); }
});
test("manual review, immutable approvals and unique student identity prevent multiple wallet rewards", () => {
  const { repository: r, service: s, approve } = setup();
  try {
    assert.throws(() => s.requireSchool(student.address), /SCHOOL_ONLY/);
    assert.throws(() => r.requestScholarship(lower(student), "MERIT"), /STUDENT_NOT_VERIFIED/);
    approve();
    assert.throws(() => r.submit(lower(student), "DIFFERENT", "CNTT"), /APPLICATION_LOCKED/);
    assert.throws(() => r.review(lower(school), lower(student), "STUDENT", false, "INCOMPLETE"), /ALREADY_REVIEWED/);
    r.submit(lower(other), "DEMO-1001", "CNTT");
    assert.throws(() => r.review(lower(school), lower(other), "STUDENT", true, "VERIFIED"), /STUDENT_ID_ALREADY_VERIFIED/);
    assert.equal(r.profile(lower(other)).application?.status, "PENDING");
    r.review(lower(school), lower(other), "STUDENT", false, "INCOMPLETE");
    assert.equal(r.submit(lower(other), "DEMO-1002", "CNTT").status, "PENDING");
    assert.equal(r.requestScholarship(lower(student), "SUPPORT").status, "PENDING");
    r.review(lower(school), lower(student), "SCHOLARSHIP", true, "VERIFIED");
    assert.equal(r.profile(lower(student)).payouts.length, 0);
  } finally { r.close(); }
});
test("20 CAMPUS is reserved once, simulation precedes durable broadcast lock, pending survives outages", async () => {
  const { repository: r, service: s, state, approve, proof } = setup();
  try {
    await assert.rejects(s.prepare(school.address, student.address, "WELCOME"), /STUDENT_NOT_VERIFIED/);
    approve();
    const p = await s.prepare(school.address, student.address, "WELCOME");
    assert.equal(BigInt(p.value), welcomeWei); assert.equal(p.to, lower(student));
    assert.equal((await s.prepare(school.address, student.address, "WELCOME")).id, p.id);
    state.estimateFails = true; await assert.rejects(begin(s, p.id)); assert.equal(r.payout(p.id).status, "PREPARED");
    state.estimateFails = false; await begin(s, p.id);
    await assert.rejects(begin(s, p.id), /PAYOUT_LOCKED/);
    state.unavailable = true; await assert.rejects(s.reconcile(p.id, hash));
    assert.equal(r.payout(p.id).txHash, hash); assert.equal(r.payout(p.id).status, "PENDING");
    state.unavailable = false; proof(p);
    assert.equal((await s.reconcile(p.id, hash)).status, "CONFIRMED");
    assert.equal((await s.prepare(school.address, student.address, "WELCOME")).id, p.id);
  } finally { r.close(); }
});
for (const status of ["CONFIRMED", "FAILED"] as const) {
  test(`retrying reconciliation keeps ${status} until chain evidence verifies a different outcome`, async () => {
    const { repository, service, state, approve, proof } = setup();
    try {
      approve();
      const payout = await service.prepare(school.address, student.address, "WELCOME");
      await begin(service, payout.id);
      proof(payout);
      state.receipt.status = status === "CONFIRMED" ? "0x1" : "0x0";
      const verified = await service.reconcile(payout.id, hash);
      assert.equal(verified.status, status);

      state.unavailable = true;
      await assert.rejects(service.reconcile(payout.id, hash), /RPC_UNAVAILABLE/);
      assert.deepEqual(repository.payout(payout.id), verified);

      state.unavailable = false;
      state.receipt = null;
      assert.deepEqual(await service.reconcile(payout.id, hash), verified);

      // A reorg can change the outcome if the transaction is included in a different block.
      proof(payout);
      state.receipt.status = status === "CONFIRMED" ? "0x0" : "0x1";
      state.reorg = true;
      await assert.rejects(service.reconcile(payout.id, hash), /RECEIPT_MISMATCH/);
      assert.deepEqual(repository.payout(payout.id), verified);

      const canonicalHash = `0x${"ef".repeat(32)}`;
      state.receipt.blockHash = canonicalHash;
      state.transaction.blockHash = canonicalHash;
      const updated = await service.reconcile(payout.id, hash);
      assert.equal(updated.status, status === "CONFIRMED" ? "FAILED" : "CONFIRMED");
      assert.equal(updated.txHash, hash);
      assert.deepEqual(repository.payout(payout.id), updated);
    } finally { repository.close(); }
  });
}

for (const kind of ["WELCOME", "SCHOLARSHIP"] as const) {
  test(`${kind}: definite non-send recovery is signer/attempt-bound and cannot release a newer or hashed attempt`, async () => {
    const { repository: r, service: s, approve, proof } = setup();
    try {
      approve();
      if (kind === "SCHOLARSHIP") { r.requestScholarship(lower(student), "MERIT"); r.review(lower(school), lower(student), "SCHOLARSHIP", true, "VERIFIED"); }
      const p = await s.prepare(school.address, student.address, kind);
      const first = await begin(s, p.id);
      assert.deepEqual(await begin(s, p.id, school.address, first.attemptToken), first);
      assert.match(first.attemptToken, /^[0-9a-f]{64}$/);
      assert.equal(JSON.stringify(r.profile(student.address)).includes(first.attemptToken), false);
      assert.throws(() => s.release(p.id, student.address, first.attemptToken, "REJECTED"), /SCHOOL_ONLY/);
      s.schools.add(lower(other));
      assert.throws(() => s.release(p.id, other.address, first.attemptToken, "REJECTED"), /PAYOUT_LOCKED/);
      assert.throws(() => s.release(p.id, school.address, "0".repeat(64), "REJECTED"), /PAYOUT_LOCKED/);
      assert.throws(() => s.release(p.id, school.address, first.attemptToken, "UNKNOWN"), /INVALID_REQUEST/);
      assert.throws(() => s.release(p.id, school.address, "invalid", "REJECTED"), /INVALID_REQUEST/);
      assert.equal(r.payout(p.id).status, "UNKNOWN");
      assert.equal(s.release(p.id, school.address, first.attemptToken, "REJECTED").status, "PREPARED");
      assert.equal(s.release(p.id, school.address, first.attemptToken, "REJECTED").status, "PREPARED");
      await assert.rejects(begin(s, p.id, school.address, first.attemptToken), /PAYOUT_ATTEMPT_RELEASED/);
      const second = await begin(s, p.id);
      assert.notEqual(second.attemptToken, first.attemptToken);
      assert.throws(() => s.release(p.id, school.address, first.attemptToken, "REJECTED"), /PAYOUT_LOCKED/);
      assert.equal(r.payout(p.id).status, "UNKNOWN");
      assert.equal(s.release(p.id, school.address, second.attemptToken, "NOT_SENT").status, "PREPARED");
      await assert.rejects(begin(s, p.id, school.address, first.attemptToken), /PAYOUT_ATTEMPT_RELEASED/);
      const third = await begin(s, p.id);
      r.attach(p.id, hash);
      assert.throws(() => s.release(p.id, school.address, third.attemptToken, "NOT_SENT"), /PAYOUT_LOCKED/);
      assert.equal(r.payout(p.id).status, "PENDING");
      assert.equal((await s.prepare(school.address, student.address, kind)).id, p.id);
      if (kind === "WELCOME") { proof(p); await s.reconcile(p.id, hash); assert.throws(() => s.release(p.id, school.address, third.attemptToken, "REJECTED"), /PAYOUT_LOCKED/); }
    } finally { r.close(); }
  });
}
test("a committed begin can be retried after losing its response with the client-held capability", async () => {
  const { repository: r, service: s, approve } = setup();
  try {
    approve(); const p = await s.prepare(school.address, student.address, "WELCOME"); const attemptToken = token();
    await begin(s, p.id, school.address, attemptToken); // commit; pretend the response never reached the caller
    assert.equal(r.payout(p.id).status, "UNKNOWN");
    const recovered = await begin(s, p.id, school.address, attemptToken);
    assert.equal(recovered.attemptToken, attemptToken); assert.equal(recovered.payout.id, p.id);
    await assert.rejects(begin(s, p.id, school.address, token()), /PAYOUT_LOCKED/);
    assert.equal(s.release(p.id, school.address, attemptToken, "NOT_SENT").status, "PREPARED");
    assert.equal((await s.prepare(school.address, student.address, "WELCOME")).id, p.id);
  } finally { r.close(); }
});

test("release fences an in-flight begin before commit and old requests cannot relock after newer cancellations", async () => {
  const { repository: r, service: s, approve, state } = setup();
  try {
    approve(); const p = await s.prepare(school.address, student.address, "WELCOME"); const attemptToken = token();
    const arrived = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    state.beforeEstimate = async () => { arrived.resolve(); await finish.promise; };
    const delayed = begin(s, p.id, school.address, attemptToken);
    await arrived.promise;
    assert.equal(s.release(p.id, school.address, attemptToken, "NOT_SENT").status, "PREPARED");
    finish.resolve();
    await assert.rejects(delayed, /PAYOUT_ATTEMPT_RELEASED/);
    assert.equal(r.payout(p.id).status, "PREPARED");
    state.beforeEstimate = undefined;
    const newer = await begin(s, p.id);
    assert.throws(() => s.release(p.id, school.address, attemptToken, "NOT_SENT"), /PAYOUT_LOCKED/);
    s.release(p.id, school.address, newer.attemptToken, "REJECTED");
    await assert.rejects(begin(s, p.id, school.address, attemptToken), /PAYOUT_ATTEMPT_RELEASED/);
    assert.equal(r.payout(p.id).status, "PREPARED");
  } finally { r.close(); }
});

for (const fault of ["revert", "amount", "payer", "recipient", "calldata", "chain", "old-block", "reorg"]) {
  test(`welcome receipt rejects ${fault} without opening a second grant`, async () => {
    const { repository: r, service: s, state, approve, proof } = setup();
    try {
      approve(); const p = await s.prepare(school.address, student.address, "WELCOME"); await begin(s, p.id); proof(p);
      if (fault === "revert") state.receipt.status = "0x0";
      if (fault === "amount") state.transaction.value = "0x1";
      if (fault === "payer") state.transaction.from = other.address;
      if (fault === "recipient") state.transaction.to = other.address;
      if (fault === "calldata") state.transaction.input = "0x";
      if (fault === "chain") state.transaction.chainId = "0x1";
      if (fault === "old-block") state.receipt.blockNumber = "0x64";
      if (fault === "reorg") state.reorg = true;
      if (fault === "revert") assert.equal((await s.reconcile(p.id, hash)).status, "FAILED");
      else { await assert.rejects(s.reconcile(p.id, hash)); assert.equal(r.payout(p.id).status, "PENDING"); }
      await assert.rejects(begin(s, p.id), /PAYOUT_LOCKED/);
    } finally { r.close(); }
  });
}
test("wrong/stale RPC blocks payouts; scholarship requires its own approval and GrantIssued proof", async () => {
  const { repository: r, service: s, state, approve, proof } = setup();
  try {
    approve(); state.chain = "0x1"; await assert.rejects(s.prepare(school.address, student.address, "WELCOME"), /WRONG_CHAIN/);
    state.chain = "0x4f25"; state.stale = true; await assert.rejects(s.prepare(school.address, student.address, "WELCOME"), /STALE_CHAIN_STATE/);
    state.stale = false; await assert.rejects(s.prepare(school.address, student.address, "SCHOLARSHIP"), /SCHOLARSHIP_NOT_APPROVED/);
    r.requestScholarship(lower(student), "MERIT"); r.review(lower(school), lower(student), "SCHOLARSHIP", true, "VERIFIED");
    const p = await s.prepare(school.address, student.address, "SCHOLARSHIP"); await begin(s, p.id); proof(p);
    await assert.rejects(s.reconcile(p.id, hash), /RECEIPT_MISMATCH/);
    const abi = new Interface(["function grant(address,bytes32) payable", "event GrantIssued(address indexed beneficiary,bytes32 indexed category,address indexed issuer,uint256 amount,uint256 balance)"]);
    const [, category] = abi.decodeFunctionData("grant", p.data);
    const event = abi.encodeEventLog(abi.getEvent("GrantIssued")!, [p.wallet, category, p.from, BigInt(p.value), BigInt(p.value)]);
    state.receipt.logs = [{ address: p.to, transactionHash: hash, blockHash, blockNumber: "0x65", ...event }];
    assert.equal((await s.reconcile(p.id, hash)).status, "CONFIRMED");
  } finally { r.close(); }
});
test("HTTP ownership, school authorization, CSRF and service activation are enforced", async t => {
  const { repository: r, service: s } = setup(); const library = new LibraryRepository(":memory:");
  const app = express(); app.use(createCampusRouter(s, library));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); r.close(); library.close(); });
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const request = (path: string, cookie = "", payload?: unknown, origin = env.CAMPUS_AUTH_ORIGIN) => fetch(`${base}/api/campus/${path}`, {
    method: payload === undefined ? "GET" : "POST", headers: { cookie, origin, "content-type": "application/json" }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  async function login(wallet: typeof student) {
    const c = await (await request("auth/challenge", "", { wallet: wallet.address })).json();
    const response = await request("auth/verify", "", { challengeId: c.challengeId, signature: await wallet.signMessage(c.message) });
    assert.equal(response.status, 200); const cookie = response.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); return cookie.split(";")[0];
  }
  const studentCookie = await login(student), schoolCookie = await login(school);
  assert.equal((await request("reviews", studentCookie)).status, 403);
  assert.equal((await request("applications", studentCookie, { studentCode: "DEMO-2001", program: "CNTT" }, "https://evil.example")).status, 403);
  assert.equal((await request("applications", studentCookie, { studentCode: "DEMO-2001", program: "CNTT", wallet: other.address })).status, 400);
  assert.equal((await request("applications", studentCookie, { studentCode: "DEMO-2001", program: "CNTT" })).status, 200);
  assert.equal((await request("activate", studentCookie, {})).status, 403);
  assert.equal((await request("reviews", schoolCookie, { wallet: student.address, kind: "STUDENT", approve: true, reason: "VERIFIED" })).status, 200);
  assert.equal((await request("activate", studentCookie, {})).status, 200);
  assert.equal(library.accountForWallet(student.address)?.role, "STUDENT");
  assert.equal((await (await request("me", schoolCookie)).json()).school, true);
  const payout = await (await request("payouts", schoolCookie, { wallet: student.address, kind: "WELCOME" })).json();
  const beginBody = { attemptToken: token() };
  assert.equal((await request(`payouts/${payout.id}/begin`, schoolCookie, {})).status, 400);
  const attempt = await (await request(`payouts/${payout.id}/begin`, schoolCookie, beginBody)).json();
  assert.deepEqual(await (await request(`payouts/${payout.id}/begin`, schoolCookie, beginBody)).json(), attempt);
  assert.equal(attempt.payout.status, "UNKNOWN");
  const release = { attemptToken: attempt.attemptToken, outcome: "REJECTED" };
  assert.equal((await request(`payouts/${payout.id}/release`, "", release)).status, 401);
  assert.equal((await request(`payouts/${payout.id}/release`, studentCookie, release)).status, 403);
  assert.equal((await request(`payouts/${payout.id}/release`, schoolCookie, release, "https://evil.example")).status, 403);
  assert.equal((await request(`payouts/${payout.id}/release`, schoolCookie, { ...release, outcome: "UNKNOWN" })).status, 400);
  assert.equal((await request(`payouts/${payout.id}/release`, schoolCookie, { ...release, attemptToken: "0".repeat(64) })).status, 409);
  assert.equal(r.payout(payout.id).status, "UNKNOWN");
  assert.equal((await request(`payouts/${payout.id}/release`, schoolCookie, release)).status, 200);
  assert.equal(r.payout(payout.id).status, "PREPARED");
  assert.equal((await request("auth/logout", studentCookie, {})).status, 204);
  assert.equal((await request("me", studentCookie)).status, 401);
});

test("real HTTP commit with lost begin/release responses remains recoverable and a user retry sends only once", async t => {
  const { repository: r, service: s, approve, proof } = setup();
  const app = express(); app.use(createCampusRouter(s));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); r.close(); });
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`, nativeFetch = globalThis.fetch;
  const auth = s.auth.createChallenge({ wallet: school.address, remoteAddress: "127.0.0.1" });
  const verified = s.auth.verifyChallenge({ challengeId: auth.challengeId, signature: await school.signMessage(auth.message), remoteAddress: "127.0.0.1" });
  const cookie = `${s.authConfig.cookieName}=${verified.token}`;
  approve(); const p = await s.prepare(school.address, student.address, "WELCOME");
  let loseBegin = true, loseRelease = true, walletCalls = 0;
  const capabilities: CampusPayoutRecovery[] = [];
  t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    const response = await nativeFetch(`${base}${path}`, { ...init, headers: { ...init.headers, origin: env.CAMPUS_AUTH_ORIGIN, cookie } });
    if (path.endsWith("/begin") && loseBegin) {
      loseBegin = false;
      assert.equal(r.payout(p.id).status, "UNKNOWN");
      assert.equal(capabilities[0].attemptToken, JSON.parse(String(init.body)).attemptToken);
      await response.body?.cancel(); throw new TypeError("Begin response lost after commit");
    }
    if (path.endsWith("/release") && loseRelease) {
      loseRelease = false;
      assert.equal(r.payout(p.id).status, "PREPARED");
      await response.body?.cancel(); throw new TypeError("Release response lost after commit");
    }
    return response;
  });
  const send = async () => { walletCalls++; return hash; };
  await assert.rejects(sendCampusPayout(p, school.address, send, { onRecovery: recovery => { if (recovery) capabilities.push(recovery); } }), /Release response lost/);
  assert.equal(walletCalls, 0);
  const recovered = await releaseCampusPayout(capabilities.at(-1)!);
  assert.equal(recovered.status, "PREPARED");
  const sent = await sendCampusPayout(recovered, school.address, send);
  assert.equal(walletCalls, 1); assert.equal(sent.hash, hash);
  proof(p);
  const confirmed = await campusApi(`payouts/${p.id}/reconcile`, { txHash: sent.hash });
  assert.equal(confirmed.status, "CONFIRMED"); assert.equal(r.profile(student.address).payouts.length, 1);
});
