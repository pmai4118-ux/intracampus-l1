import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface } from 'ethers';
import fixture from '../../docs/fixtures/library-v1.json' with { type: 'json' };
import { LibraryApi } from '../lib/library-api.ts';
import { LibraryTransactions } from '../lib/library-transactions.ts';
import { WalletTransactionError } from '../lib/wallet.ts';
const librarian = `0x${'11'.repeat(20)}`, borrower = `0x${'44'.repeat(20)}`, escrow = `0x${'22'.repeat(20)}`, treasury = `0x${'33'.repeat(20)}`, id = `0x${'ab'.repeat(32)}`, bookId = `0x${'bc'.repeat(32)}`, hash = `0x${'cd'.repeat(32)}`;
const iface = new Interface(fixture.abi);
function setup() {
 const deployment: any = {chainId:20261, escrow:{address:escrow,transactionHash:hash,abi:fixture.abi}, roles:{librarian}, treasury, books:[{bookId,depositWei:'100'}]};
 const proof = {chainId:20261,contractAddress:escrow,txHash:hash,blockHash:hash,blockNumber:1,logIndex:0,eventName:'DepositReceived',requestId:id,borrower};
 const request: any = {requestId:id,bookId,status:'PENDING_APPROVAL',refundStatus:'NONE',depositWei:'100',depositIntent:null,approvalDeadline:200,loanId:id,transactions:[{action:'deposit',txHash:hash,status:'CONFIRMED',submittedAt:1,proof}],createdAt:1,updatedAt:1};
 const loan: any = {loanId:id,requestId:id,bookId,borrower,status:'SETTLEMENT_PENDING',approvedAt:1,dueAt:2,returnRequestedAt:3,returnReceivedAt:4,settlement:null};
 request.transactions.push({action:'confirmReturn',txHash:hash,status:'CONFIRMED',submittedAt:2,proof:{...proof,eventName:'PhysicalReturnConfirmed'}});
 const preview = {outcome:'RETURNED',returnedAt:4,lateFeeWei:'0',repairFeeWei:'1',overdueForfeitWei:'0',totalRetainedWei:'1',refundWei:'99',maintenanceRequired:true};
 const intent: any = {intentId:'ef'.repeat(32),requestId:id,loanId:id,borrower,chainId:20261,escrow,treasury, walletCall:{to:escrow,data:iface.encodeFunctionData('settleReturn',[id,'1']),valueWei:'0'},chainTime:100,outcome:'RETURNED',preview};
 const state = {address:librarian,chainId:BigInt(20261),canProceed:true,blockTimestamp:BigInt(100)};
 const values = new Map<string,string>(); let sends = 0;
 const storage = {getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v)},removeItem:(k:string)=>{values.delete(k)},key:(i:number)=>Array.from(values.keys())[i]??null,get length(){return values.size}};
 const wallet = {getSnapshot:()=>state, refresh:async()=>{}, sendTransactionWithGuard:async (_a:string,_t:any,guard:()=>void)=>{guard();sends++;throw new WalletTransactionError('SEND_OUTCOME_UNKNOWN','unknown')}};
 const api = new LibraryApi(async p=> { const path=String(p); if(path.endsWith('/session')) return Response.json({account:{wallet:librarian,role:'LIBRARIAN'},expiresAt:999}); if(path.endsWith('/loans')) return Response.json([loan]); return Response.json(path.endsWith('/transactions')?{request}:request); });
 const options = {deployment,account:librarian,role:'LIBRARIAN' as const,storage,wallet,api,lock:async (_k:string, run:()=>Promise<void>)=>run()};
 return {controller:new LibraryTransactions(options),options,request,loan,intent,proof,state,wallet,storage,sends:()=>sends};
}
test('librarian session gates staff queue and wallet',async()=>{ const s=setup(); const c=await s.controller.prepare(id,'approve'); assert.equal(c.recipient,borrower); s.state.blockTimestamp=BigInt(200); await assert.rejects(s.controller.prepare(id,'approve'),/ACTION_UNAVAILABLE/); s.state.blockTimestamp=BigInt(100); s.state.address=borrower; await assert.rejects(s.controller.prepare(id,'approve'),/WALLET_SESSION_CHANGED/); });
test('deposit proof and settlement calldata are bound to request and requested repair',async()=>{ const s=setup(); s.proof.contractAddress=borrower; await assert.rejects(s.controller.prepare(id,'approve'),/INTENT_MISMATCH/); s.proof.contractAddress=escrow; await assert.rejects(s.controller.prepare(id,'return',s.intent,'2'),/INTENT_MISMATCH/); const c=await s.controller.prepare(id,'return',s.intent,'1'); assert.equal(c.settlementIntentId,s.intent.intentId); });
test('settlement intent is journaled at broadcast guard and survives unknown reload',async()=>{ const s=setup(); const call=await s.controller.prepare(id,'return',s.intent,'1'); assert.equal(s.controller.journal(id,'return'),null); await assert.rejects(s.controller.send(call),/SEND_OUTCOME_UNKNOWN/); const reload=new LibraryTransactions(s.options); assert.equal(reload.journal(id,'return')?.settlementIntentId,s.intent.intentId); assert.equal(reload.listJournals().length,1); await assert.rejects(reload.send(call),/RECOVERY_REQUIRED/); assert.equal(s.sends(),1); });
test('returned and lost settlement guards enforce distinct receipt states',async()=>{ const s=setup(); const lost={...s.intent,outcome:'LOST',preview:{outcome:'LOST',replacementPriceWei:'200',totalRetainedWei:'100',refundWei:'0',shortfallWei:'100'},walletCall:{...s.intent.walletCall,data:iface.encodeFunctionData('settleLost',[id])}}; await assert.rejects(s.controller.prepare(id,'settle',lost),/ACTION_UNAVAILABLE/); s.loan.status='ACTIVE'; s.loan.returnReceivedAt=null; s.request.transactions.pop(); await s.controller.prepare(id,'settle',lost); await assert.rejects(s.controller.prepare(id,'return',s.intent,'1'),/ACTION_UNAVAILABLE/); });

test('unknown reject stays discoverable and reconciles after request leaves queue', async () => {
  const s = setup();
  s.request.transactions.pop();
  const call = await s.controller.prepare(id, 'reject');
  await assert.rejects(s.controller.send(call), /SEND_OUTCOME_UNKNOWN/);
  s.request.status = 'REJECTED';
  s.request.refundStatus = 'REFUNDED';
  s.request.transactions.push({ action:'reject', txHash:hash, status:'CONFIRMED', submittedAt:2,
    proof:{...s.proof, eventName:'RequestRejected'} });
  const reloaded = new LibraryTransactions(s.options);
  assert.equal(reloaded.listJournals().length, 1);
  assert.equal(reloaded.journal(id, 'reject')?.phase, 'unknown');
  await reloaded.reconcile(id, 'reject');
  assert.equal(reloaded.journal(id, 'reject')?.phase, 'confirmed');
  assert.equal(reloaded.journal(id, 'reject')?.hash, hash);
  assert.equal(s.sends(), 1);
});

test('changed session role or wallet and mismatched deployment signer stop staff preflight', async () => {
  const s = setup(); let role = 'STUDENT', wallet = librarian;
  const api = new LibraryApi(async path => String(path).endsWith('/session')
    ? Response.json({ account:{ wallet, role }, expiresAt:999 }) : Response.json(s.request));
  const controller = new LibraryTransactions({ ...s.options, api });
  await assert.rejects(controller.prepare(id, 'reject'), /WALLET_SESSION_CHANGED/);
  role = 'LIBRARIAN'; wallet = borrower;
  await assert.rejects(controller.prepare(id, 'reject'), /WALLET_SESSION_CHANGED/);
  wallet = librarian;
  const wrongDeployment = new LibraryTransactions({ ...s.options, deployment:{ ...s.options.deployment, roles:{ librarian:borrower } } });
  await assert.rejects(wrongDeployment.prepare(id, 'reject'), /WALLET_SESSION_CHANGED/);
  assert.equal(s.sends(), 0);
});

test('incorrect event proof cannot complete staff recovery', async () => {
  const s = setup(); s.request.transactions.pop();
  const call = await s.controller.prepare(id, 'reject');
  await assert.rejects(s.controller.send(call), /SEND_OUTCOME_UNKNOWN/);
  s.request.transactions.push({ action:'reject', txHash:hash, status:'CONFIRMED', submittedAt:2,
    proof:{...s.proof, eventName:'LoanApproved'} });
  await assert.rejects(s.controller.reconcile(id, 'reject'), /INTENT_MISMATCH/);
  assert.equal(s.controller.journal(id, 'reject')?.phase, 'unknown');
});

test('cancelling settlement preview or reloading before send creates no unknown journal', async () => {
  const s = setup();
  await s.controller.prepare(id, 'return', s.intent, '1');
  assert.equal(s.controller.journal(id, 'return'), null);
  const reloaded = new LibraryTransactions(s.options);
  assert.equal(reloaded.listJournals().length, 0);
  await reloaded.prepare(id, 'return', s.intent, '1');
  assert.equal(s.sends(), 0);
});

test('storage failure at broadcast guard prevents settlement send', async () => {
  const s = setup();
  const call = await s.controller.prepare(id, 'return', s.intent, '1');
  s.storage.setItem = () => { throw new Error('quota'); };
  await assert.rejects(s.controller.send(call), /STORAGE_BLOCKED/);
  assert.equal(s.sends(), 0);
  assert.equal(s.controller.journal(id, 'return'), null);
});

test('approval uses chain deadline boundary and no-copy only permits rejection', async () => {
  const s = setup();
  s.state.blockTimestamp = BigInt(199);
  await s.controller.prepare(id, 'approve');
  s.state.blockTimestamp = BigInt(200);
  await assert.rejects(s.controller.prepare(id, 'approve'), /ACTION_UNAVAILABLE/);
  s.state.blockTimestamp = BigInt(201);
  await assert.rejects(s.controller.prepare(id, 'approve'), /ACTION_UNAVAILABLE/);
  s.request.status = 'REJECTED_NO_COPY';
  await assert.rejects(s.controller.prepare(id, 'approve'), /ACTION_UNAVAILABLE/);
  await s.controller.prepare(id, 'reject');
  assert.equal(s.sends(), 0);
});

test('settlement preview rejects wrong chain, parties, outcome, value and malformed repair amounts', async () => {
  const s = setup();
  for (const change of [ {chainId:1}, {borrower:librarian}, {escrow:borrower}, {treasury:borrower}, {outcome:'LOST'}, {walletCall:{...s.intent.walletCall,valueWei:'1'}} ]) {
    await assert.rejects(s.controller.prepare(id,'return',{...s.intent,...change},'1'), /INTENT_MISMATCH/);
  }
  for (const amount of ['', '-1', '1.0', '1e2', (BigInt(2) ** BigInt(256)).toString()]) {
    await assert.rejects(s.controller.prepare(id,'return',s.intent,amount), /INTENT_MISMATCH/);
  }
  assert.equal(s.sends(), 0);
});

test('unknown settlement discovered by request is tracked with its durable intent before confirmation', async () => {
  const s = setup();
  const call = await s.controller.prepare(id, 'return', s.intent, '1');
  await assert.rejects(s.controller.send(call), /SEND_OUTCOME_UNKNOWN/);
  s.request.transactions.push({ action:'return', txHash:hash, status:'CONFIRMED', submittedAt:3,
    proof:{...s.proof, eventName:'ReturnSettled'} });
  const tracked: unknown[][] = [];
  s.options.api.track = async (...args: unknown[]) => { tracked.push(args); return s.request; };
  const reloaded = new LibraryTransactions(s.options);
  await reloaded.reconcile(id, 'return');
  assert.deepEqual(tracked, [[id,'return',hash,s.intent.intentId]]);
  assert.equal(reloaded.journal(id, 'return')?.phase, 'confirmed');
});

test('settlement recovery retains unknown when intent tracking fails', async () => {
  const s = setup();
  const call = await s.controller.prepare(id, 'return', s.intent, '1');
  await assert.rejects(s.controller.send(call), /SEND_OUTCOME_UNKNOWN/);
  s.request.transactions.push({ action:'return', txHash:hash, status:'CONFIRMED', submittedAt:3,
    proof:{...s.proof, eventName:'ReturnSettled'} });
  s.options.api.track = async () => { throw new Error('audit unavailable'); };
  await assert.rejects(s.controller.reconcile(id, 'return'), /audit unavailable/);
  assert.equal(s.controller.journal(id, 'return')?.phase, 'unknown');
});

test('staff recovery rejects a confirmed event if its deposit proof has wrong chain, escrow, request or hash', async () => {
  for (const field of ['chainId','contractAddress','requestId','txHash']) {
    const s = setup(); s.request.transactions.pop();
    const call = await s.controller.prepare(id, 'reject');
    await assert.rejects(s.controller.send(call), /SEND_OUTCOME_UNKNOWN/);
    s.request.transactions.push({action:'reject',txHash:hash,status:'CONFIRMED',submittedAt:3,proof:{...s.proof,eventName:'RequestRejected'}});
    const depositProof = s.request.transactions[0].proof;
    depositProof[field] = field === 'chainId' ? 1 : field === 'contractAddress' ? borrower : `0x${'12'.repeat(32)}`;
    s.options.api.getRequest = async () => s.request;
    await assert.rejects(s.controller.reconcile(id, 'reject'), /INTENT_MISMATCH/);
    assert.equal(s.controller.journal(id,'reject')?.phase,'unknown');
  }
});

test('local pending or unknown journal blocks another preflight', async () => {
  const s = setup();
  const call = await s.controller.prepare(id, 'return', s.intent, '1');
  await assert.rejects(s.controller.send(call), /SEND_OUTCOME_UNKNOWN/);
  await assert.rejects(s.controller.prepare(id, 'return', s.intent, '1'), /RECOVERY_REQUIRED/);
  assert.throws(() => s.controller.assertNoPending(id,'return'), /RECOVERY_REQUIRED/);
  assert.equal(s.sends(),1);
});
