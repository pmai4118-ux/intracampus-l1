import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, id } from 'ethers';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import type { AuthService } from '../src/modules/auth/auth.service.ts';
import type { LibraryService } from '../src/modules/library/library.service.ts';
import type { LibraryAuthConfig } from '../src/modules/auth/auth.config.ts';
import type { InvoiceCreationService } from '../src/modules/invoices/invoices.service.ts';
import type { GrantsService } from '../src/modules/grants/grants.service.ts';
import type { ReceiptService } from '../src/modules/invoices/receipt.service.ts';
import { CanteenRepository } from '../src/modules/canteen/canteen.repository.ts';
import { CanteenService } from '../src/modules/canteen/canteen.service.ts';
import { createCanteenRouter } from '../src/modules/canteen/canteen.routes.ts';
const manifest=JSON.parse(readFileSync(new URL('../../docs/fixtures/b03-l05-l06-local.json',import.meta.url),'utf8')).manifest;
manifest.environment='avalanche-l1';
const wallet='0x'+'12'.repeat(20), hash='0x'+'ab'.repeat(32), other='0x'+'34'.repeat(20);
function setup() {
 const repo=new CanteenRepository(':memory:');repo.seed();
 const iface=new Interface(manifest.contracts.PurposeBoundGrantVault.abi);
 let tx:any=null, grant:any=null, receipt:any=null;
 const rpc={call:async(method:string)=>{if(method==='eth_chainId')return '0x4f25';if(method==='eth_getBlockByNumber')return {number:'0xa',timestamp:'0x'+Math.floor(Date.now()/1000).toString(16)};if(method==='eth_getTransactionByHash')return tx;throw Error(method);}};
 const service=new CanteenService(repo,{manifest,rpc,invoices:{createForService:async()=>({envelope:{invoice:{invoiceId:id('order')}}})} as unknown as InvoiceCreationService,
   receipts:{lookup:async()=>receipt} as unknown as ReceiptService,grants:{lookup:async(_a:string,h?:string)=>h?grant:{balanceWei:'5000000000000000000000',allowedMerchants:[{address:manifest.merchants.canteen.address,allowed:true}]}} as unknown as GrantsService});
 return {repo,service,iface,setTx:(v:any)=>{tx=v;},setGrant:(v:any)=>{grant=v;},setReceipt:(v:any)=>{receipt=v;}};
}
test('FOOD verifies exact sender, recipient, calldata, event amount and block; pending is not paid',async()=>{
 const h=setup();try {
 const initial=h.repo.create(wallet,'food','FOOD',[{dishId:'com-tam',quantity:1}]);let {order}=await h.service.prepare(initial);assert.equal(order.afterBlock,10);
 const transaction={from:wallet,to:manifest.contracts.PurposeBoundGrantVault.address,input:h.iface.encodeFunctionData('spend',[manifest.merchants.canteen.address,id('FOOD'),order.totalWei]),value:'0x0',blockNumber:'0xb'};
 h.setTx({...transaction,from:other});await assert.rejects(h.service.track(order,hash),/RECEIPT_MISMATCH/);assert.equal(h.repo.get(order.id,wallet).txHash,null);
 h.setTx({...transaction,input:h.iface.encodeFunctionData('spend',[other,id('FOOD'),order.totalWei])});await assert.rejects(h.service.track(order,hash),/RECEIPT_MISMATCH/);
 h.setTx({...transaction,blockNumber:'0xa'});await assert.rejects(h.service.track(order,hash),/RECEIPT_MISMATCH/);
 h.setTx(transaction);h.setGrant({transaction:{status:'pending',events:[]}});order=await h.service.track(order,hash);assert.equal(order.status,'AWAITING_PAYMENT');
 const event={event:'GrantSpent',beneficiary:wallet,merchant:manifest.merchants.canteen.address,category:id('FOOD'),amountWei:order.totalWei,blockNumber:11};
 h.setGrant({transaction:{status:'verified',events:[{...event,amountWei:'1'}]}});await assert.rejects(h.service.track(order,hash),/RECEIPT_MISMATCH/);
 h.setGrant({transaction:{status:'verified',events:[event]}});const paid=await h.service.track(order,hash);assert.equal(paid.status,'PAID');assert.equal(paid.paidAmountWei,order.totalWei);
 assert.deepEqual(await h.service.track(paid,hash),paid);
 }finally{h.repo.close();}
});
test('wallet acceptance requires bound payer, invoice total and FOOD merchant',async()=>{
 const h=setup();try {
 let {order}=await h.service.prepare(h.repo.create(wallet,'wallet','WALLET',[{dishId:'pho-bo',quantity:1}]));
 h.setTx({from:wallet,to:manifest.contracts.CampusPaymentRegistry.address,blockNumber:'0xb',value:'0x0'});
 const r={payer:wallet,txHash:hash,merchant:manifest.merchants.canteen.address,category:id('FOOD'),originalAmount:order.totalWei,paidAmount:(BigInt(order.totalWei)*9n/10n).toString()};
 h.setReceipt({httpStatus:200,body:{status:'paid',receipt:{...r,payer:other}}});await assert.rejects(h.service.track(order,hash),/RECEIPT_MISMATCH/);
 h.setReceipt({httpStatus:200,body:{status:'paid',receipt:r}});order=(await h.service.prepare(order)).order;assert.equal(order.status,'PAID');assert.equal(order.paidAmountWei,r.paidAmount);
 }finally{h.repo.close();}
});
test('HTTP requires own student session, same Origin and server-side prices; held wallets can reconcile',async t=>{
 const h=setup();t.after(()=>h.repo.close());let held=false;
 const auth={session:(token:string)=>token==='good'?{account:{wallet,role:'STUDENT'}}:token==='other'?{account:{wallet:other,role:'STUDENT'}}:null} as unknown as AuthService;
 const app=express();app.use(createCanteenRouter(h.service,auth,{cookieName:'session',origin:'http://localhost:3000'} as LibraryAuthConfig,{accountStatus:async()=>({held})} as unknown as LibraryService));
 const server=createServer(app).listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const address=server.address();assert(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}/api/canteen`;
 const post=(path:string,b:unknown,cookie='good',origin='http://localhost:3000')=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',cookie:`session=${cookie}`,origin},body:JSON.stringify(b)});
 assert.equal((await fetch(url+'/menu')).status,200);assert.equal((await fetch(url+'/orders')).status,401);
 const b={method:'FOOD',idempotencyKey:'11111111-1111-4111-8111-111111111111',items:[{dishId:'com-tam',quantity:1}]};
 assert.equal((await post('/orders',b,'good','http://evil.test')).status,403);
 assert.equal((await post('/orders',{...b,totalWei:'1'})).status,400);
 assert.equal((await post('/orders',{...b,items:[{dishId:'com-tam',quantity:-1}]})).status,400);
 const result=await post('/orders',b);assert.equal(result.status,201);const order=await result.json();assert.equal(order.totalWei,'1000000000000000000000');
 assert.equal((await post(`/orders/${order.id}/prepare`,{},'other')).status,404);
 held=true;assert.equal((await post('/orders',b)).status,403);assert.equal((await post(`/orders/${order.id}/prepare`,{})).status,403);
 assert.equal((await post(`/orders/${order.id}/transactions`,{txHash:hash})).status,409);
 const pendingWallet=h.repo.create(wallet,'pending-wallet','WALLET',[{dishId:'pho-bo',quantity:1}]);h.repo.prepare(pendingWallet.id,wallet,10,id('pending-wallet'));
 let scans=0;h.service.reconcileWallet=async order=>{scans++;return order;};
 const list=await fetch(url+'/orders',{headers:{cookie:'session=good'}});assert.equal(list.status,200);assert.equal(scans,0);
});


test('expired unpaid invoice becomes a terminal expired order; later verified proof still reconciles',async()=>{
 const h=setup();try {
  const initial=h.repo.create(wallet,'expired','WALLET',[{dishId:'com-tam',quantity:1}]);const {order}=await h.service.prepare(initial);
  h.setReceipt({httpStatus:200,body:{status:'expired',receipt:null,transaction:null}});
  const expired=await h.service.prepare(order);assert.equal(expired.order.status,'EXPIRED');assert.equal(expired.envelope,null);
  assert.equal(h.repo.get(order.id,wallet).status,'EXPIRED');
  h.setTx({from:wallet,to:manifest.contracts.CampusPaymentRegistry.address,blockNumber:'0xb',value:'0x0'});
  h.setReceipt({httpStatus:200,body:{status:'paid',receipt:{payer:wallet,txHash:hash,merchant:manifest.merchants.canteen.address,category:id('FOOD'),originalAmount:order.totalWei,paidAmount:order.totalWei}}});
  assert.equal((await h.service.prepare(expired.order)).order.status,'PAID');
 }finally{h.repo.close();}
});
