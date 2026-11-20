import assert from "node:assert/strict";
import test from "node:test";
import { campusApi, campusLogin, releaseCampusPayout, sendCampusPayout, validateCampusPayout, type CampusPayoutRecovery } from "../lib/campus.ts";
import { WalletController, WalletTransactionError } from "../lib/wallet.ts";
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

test("EIP-1193 4001 from the transaction prompt restores the same payout and allows a successful retry", async t => {
  let rejected = true, sends = 0, begins = 0;
  const requests: string[] = [], updates: CampusPayout[] = [], tokens: string[] = [];
  const provider = { on() {}, removeListener() {}, async request({ method }: { method: string }) {
    if (method === "eth_accounts") return [from];
    if (method === "eth_chainId") return "0x4f25";
    if (method === "eth_sendTransaction") { sends++; if (rejected) throw { code: 4001 }; return `0x${"ab".repeat(32)}`; }
    throw Error(method);
  } };
  const controller = new WalletController({ provider, config: { rpcUrl: "https://rpc.example", sbtAddress: wallet }, rpc: async method => {
    if (method === "eth_chainId") return "0x4f25";
    if (method === "eth_getBlockByNumber") return { number: "0x1", timestamp: "0x1" };
    if (method === "eth_getBalance") return "0x0";
    if (method === "eth_call") return `0x${"0".repeat(calls++ % 2 ? 128 : 64)}`;
    throw Error(method);
  } });
  let calls = 0;
  await controller.start(); t.after(() => controller.dispose());
  t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    requests.push(path); const body = JSON.parse(String(init.body));
    if (path.endsWith("/begin")) { begins++; tokens.push(body.attemptToken); return Response.json({ payout: { ...p, status: "UNKNOWN" }, attemptToken: body.attemptToken }); }
    assert.equal(path, `/api/campus/payouts/${p.id}/release`);
    assert.deepEqual(body, { attemptToken: tokens[0], outcome: "REJECTED" });
    return Response.json(p);
  });
  const send = (account: string, tx: Parameters<WalletController["sendTransaction"]>[1]) => controller.sendTransaction(account,tx);
  const cancelled = await sendCampusPayout(p,from,send,{onPayout:value=>updates.push(value)});
  assert.equal(cancelled.hash,null); assert.equal(cancelled.payout.id,p.id); assert.equal(cancelled.payout.status,"PREPARED");
  assert.deepEqual(updates.map(p=>p.status),["UNKNOWN","PREPARED"]);
  rejected = false;
  const sent = await sendCampusPayout(cancelled.payout,from,send);
  assert.match(sent.hash!,/^0x[0-9a-f]{64}$/); assert.equal(sent.payout.status,"PENDING");
  assert.equal(sends,2); assert.equal(begins,2); assert.equal(requests.filter(path=>path.endsWith("/release")).length,1);
  assert.notEqual(tokens[0], tokens[1]);
});

for (const error of [new WalletTransactionError("SEND_OUTCOME_UNKNOWN","unknown"), Error("RPC timeout"), { code:4001 }]) {
  test(`ambiguous/unclassified send error ${error instanceof Error ? error.message : "raw provider error"} stays locked`, async t => {
    const paths: string[] = [];
    t.mock.method(globalThis,"fetch",async (path:string,init:RequestInit) => { paths.push(path); return Response.json({ payout:{...p,status:"UNKNOWN"},attemptToken:JSON.parse(String(init.body)).attemptToken }); });
    let recovery: CampusPayoutRecovery | null = null;
    await assert.rejects(sendCampusPayout(p,from,async()=>{throw error;},{onRecovery:value=>{recovery=value;}}));
    assert.deepEqual(paths,[`/api/campus/payouts/${p.id}/begin`]); assert.equal(recovery,null);
  });
}

test("a definite pre-send failure releases only its attempt; lost release response can retry without sending again", async t => {
  let recovery: CampusPayoutRecovery | null = null, releaseCalls = 0, sends = 0, attemptToken = "";
  t.mock.method(globalThis,"fetch",async (path:string,init:RequestInit) => {
    if (path.endsWith("/begin")) { attemptToken = JSON.parse(String(init.body)).attemptToken; return Response.json({ payout:{...p,status:"UNKNOWN"},attemptToken }); }
    const body = JSON.parse(String(init.body)); assert.equal(body.attemptToken,attemptToken); assert.equal(body.outcome,"NOT_SENT");
    releaseCalls++; if(releaseCalls===1) throw Error("Response lost"); return Response.json(p);
  });
  await assert.rejects(sendCampusPayout(p,from,async()=>{sends++;throw new WalletTransactionError("WRONG_CHAIN","not-sent");},{onRecovery:value=>{recovery=value;}}),/Response lost/);
  assert.ok(recovery);
  assert.equal((await releaseCampusPayout(recovery)).status,"PREPARED"); assert.equal(sends,1); assert.equal(releaseCalls,2);
});

test("client retains the capability before begin; a committed but lost response restores without calling the wallet", async t => {
  const retained: CampusPayoutRecovery[] = [];
  let lost = true, committedToken = "", walletCalls = 0, firstToken = "", beginCalls = 0;
  t.mock.method(globalThis,"fetch",async (path:string,init:RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (path.endsWith("/begin")) {
      beginCalls++; assert.equal(retained.at(-1)?.attemptToken,body.attemptToken); assert.match(body.attemptToken,/^[0-9a-f]{64}$/);
      committedToken = body.attemptToken;
      if(lost) { firstToken = committedToken; throw Error("Response lost after server commit"); }
      return Response.json({ payout:{...p,status:"UNKNOWN"},attemptToken:committedToken });
    }
    assert.equal(body.attemptToken,committedToken); assert.equal(body.outcome,"NOT_SENT"); committedToken = "";
    return Response.json(p);
  });
  const send = async()=>{walletCalls++;return `0x${"cd".repeat(32)}`;};
  const callbacks = {onRecovery:(value:CampusPayoutRecovery|null)=>{if(value)retained.push(value);}};
  const recovered = await sendCampusPayout(p,from,send,callbacks);
  assert.equal(recovered.payout.status,"PREPARED"); assert.equal(recovered.hash,null); assert.equal(walletCalls,0); assert.equal(beginCalls,1);
  lost = false;
  const sent = await sendCampusPayout(recovered.payout,from,send,callbacks);
  assert.equal(walletCalls,1); assert.equal(sent.payout.status,"PENDING"); assert.notEqual(committedToken,firstToken);
});

test("lost begin and release responses retain a recovery-only retry without ever opening the wallet", async t => {
  let recovery: CampusPayoutRecovery | null = null, releaseCalls = 0, walletCalls = 0, token = "";
  t.mock.method(globalThis,"fetch",async (path:string,init:RequestInit) => {
    const body = JSON.parse(String(init.body));
    if(path.endsWith("/begin")) { token=body.attemptToken; throw Error("Begin response lost"); }
    assert.equal(body.attemptToken,token); assert.equal(body.outcome,"NOT_SENT");
    if(++releaseCalls===1) throw Error("Release response lost");
    return Response.json(p);
  });
  await assert.rejects(sendCampusPayout(p,from,async()=>{walletCalls++;return "0x";},{onRecovery:value=>{recovery=value;}}),/Release response lost/);
  assert.ok(recovery);
  assert.equal((await releaseCampusPayout(recovery)).status,"PREPARED"); assert.equal(walletCalls,0); assert.equal(releaseCalls,2);
});

test("a begin owned by another attempt clears local recovery proof and never releases that attempt", async t => {
  const paths:string[]=[]; let recovery:CampusPayoutRecovery|null=null;
  t.mock.method(globalThis,"fetch",async (path:string)=>{paths.push(path);return Response.json({error:{code:"PAYOUT_LOCKED"}},{status:409});});
  await assert.rejects(sendCampusPayout(p,from,async()=>{assert.fail("wallet must not open");},{onRecovery:value=>{recovery=value;}}),/PAYOUT_LOCKED/);
  assert.deepEqual(paths,[`/api/campus/payouts/${p.id}/begin`]); assert.equal(recovery,null);
});
