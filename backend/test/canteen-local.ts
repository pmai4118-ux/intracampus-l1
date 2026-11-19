// Explicitly isolated Anvil integration; never uses .env or a user wallet.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContractFactory, JsonRpcProvider, Wallet, id, keccak256 } from 'ethers';
import { CanteenRepository } from '../src/modules/canteen/canteen.repository.ts';
import { CanteenService } from '../src/modules/canteen/canteen.service.ts';
import { SqliteInvoiceRepository } from '../src/modules/invoices/invoices.repository.ts';
import { InvoiceCreationService } from '../src/modules/invoices/invoices.service.ts';
import { ReceiptService } from '../src/modules/invoices/receipt.service.ts';
import { GrantsService } from '../src/modules/grants/grants.service.ts';
import { HttpInvoiceRpc } from '../src/modules/invoices/invoices.rpc.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { createCanteenRouter } from '../src/modules/canteen/canteen.routes.ts';
import type { AuthService } from '../src/modules/auth/auth.service.ts';
import type { LibraryAuthConfig } from '../src/modules/auth/auth.config.ts';
import type { LibraryService } from '../src/modules/library/library.service.ts';
const url=process.argv[2],artifactsDir=process.argv[3],output=process.argv[4];
assert(url&&/^http:\/\/127\.0\.0\.1:\d+$/.test(url)&&artifactsDir&&output,'Usage: node test/canteen-local.ts <loopback-anvil> <contracts-dir> <output.json>');
const provider=new JsonRpcProvider(url,undefined,{cacheTimeout:-1,batchMaxCount:1});provider.pollingInterval=50;
const dir=mkdtempSync(join(tmpdir(),'canteen-evm-')), repo=new CanteenRepository(join(dir,'canteen.sqlite')), invoices=new SqliteInvoiceRepository(join(dir,'invoices.sqlite'));
let grants:GrantsService|undefined;
try {
 assert.match(await provider.send('web3_clientVersion',[]),/anvil/i);assert.equal((await provider.getNetwork()).chainId,20261n);
 const admin=await provider.getSigner(0),student=await provider.getSigner(3),parking=await provider.getSigner(4),merchant=await provider.getSigner(5),pos=Wallet.createRandom();
 const roles={deployer:await admin.getAddress(),sbtIssuer:await admin.getAddress(),grantIssuer:await admin.getAddress(),posSigner:pos.address};
 const names=['StudentSBTIdentity','CampusPaymentRegistry','PurposeBoundGrantVault'];const deployed:any={},contracts:any={};
 for(const name of names) {
  const artifact=JSON.parse(readFileSync(join(artifactsDir,'out',name+'.sol',name+'.json'),'utf8'));
  const metadata=typeof artifact.metadata==='string'?JSON.parse(artifact.metadata):artifact.metadata;
  for(const [source,expected] of Object.entries(metadata.sources) as [string,{keccak256:string}][]) {
   const bytes=readFileSync(join(artifactsDir,source));assert.equal(keccak256(bytes),expected.keccak256,'stale compiler artifact '+source);
   if(source.startsWith('src/'))assert.equal(readFileSync(new URL('../../contracts/'+source,import.meta.url),'utf8').replaceAll('\r\n','\n'),bytes.toString('utf8').replaceAll('\r\n','\n'),'worktree contract differs');
  }
  const args=name==='StudentSBTIdentity'?[roles.sbtIssuer]:name==='CampusPaymentRegistry'?[roles.deployer,pos.address,deployed.StudentSBTIdentity.address]:[roles.grantIssuer,deployed.CampusPaymentRegistry.address];
  const c=await new ContractFactory(artifact.abi,artifact.bytecode.object,admin).deploy(...args);await c.waitForDeployment();const r=(await c.deploymentTransaction()!.wait())!;
  deployed[name]={address:await c.getAddress(),abiVersion:1,abi:artifact.abi,transactionHash:r.hash,blockNumber:r.blockNumber,blockHash:r.blockHash,runtimeCodeHash:keccak256(await provider.getCode(await c.getAddress()))};contracts[name]=c;
 }
 const merchants={parking:{address:await parking.getAddress(),category:id('PARKING')},canteen:{address:await merchant.getAddress(),category:id('FOOD')}};
 for(const m of Object.values(merchants))await (await contracts.CampusPaymentRegistry.setMerchantCategory(m.address,m.category,true)).wait();
 const account=await student.getAddress();await (await contracts.StudentSBTIdentity.mint(account,BigInt((await provider.getBlock('latest'))!.timestamp)+86400n)).wait();
 await (await contracts.PurposeBoundGrantVault.grant(account,id('FOOD'),{value:5000n*10n**18n})).wait();
 const manifest={schemaVersion:1,status:'deployed',chainId:20261,abiVersion:1,environment:'local-anvil',contracts:deployed,roles,merchants};
 const rpc=new HttpInvoiceRpc(url),deployment={contractAddress:deployed.CampusPaymentRegistry.address,deploymentBlock:deployed.CampusPaymentRegistry.blockNumber};
 const creation=new InvoiceCreationService({repository:invoices,rpc,deployment,config:{merchant:merchants.parking.address,privateKey:pos.privateKey,expectedSigner:pos.address,studentSbt:deployed.StudentSBTIdentity.address}});
 grants=new GrantsService({rpcUrl:url,deployment:manifest,allowLocal:true,provider});const receipts=new ReceiptService({repository:invoices,rpc,deployment});
 const service=new CanteenService(repo,{rpc,invoices:creation,receipts,grants,manifest,allowLocal:true});repo.seed();const cases=[];
 for(const method of ['WALLET','FOOD'] as const) {
  const created=repo.create(account,method,method,[{dishId:'com-tam',quantity:1}]);const prepared=await service.prepare(created);const before=await provider.getBalance(merchants.canteen.address);
  let tx;
  if(method==='WALLET') {const e=prepared.envelope!,i=e.invoice;const quote=await contracts.CampusPaymentRegistry.quoteInvoice(i,account);
   tx=await contracts.CampusPaymentRegistry.connect(student).payInvoice(i,e.signature,{value:quote.paidAmount});
  } else tx=await contracts.PurposeBoundGrantVault.connect(student).spend(merchants.canteen.address,id('FOOD'),created.totalWei);
  const raw=await tx.wait();assert.equal(raw.status,1);const paid=await service.track(prepared.order,tx.hash);assert.equal(paid.status,'PAID');
  const expected=BigInt(created.totalWei)*(method==='WALLET'?9n:10n)/10n;assert.equal(paid.paidAmountWei,expected.toString());assert.equal(await provider.getBalance(merchants.canteen.address)-before,expected);
  assert.equal((await service.track(paid,tx.hash)).status,'PAID');cases.push({method,orderId:paid.id,totalWei:paid.totalWei,paidAmountWei:paid.paidAmountWei,txHash:tx.hash,blockNumber:raw.blockNumber});
 }
 assert.equal(await contracts.PurposeBoundGrantVault.balances(account,id('FOOD')),(5000n-18n)*10n**18n);
 // Lose the callback after a real payment. Only auth and the hold flag are HTTP fixtures.
 let invoiceCreations=0;
 const originalCreate=creation.createForService.bind(creation);
 creation.createForService=async(...args)=>{invoiceCreations++;return originalCreate(...args);};
 const lost=await service.prepare(repo.create(account,'lost-update','WALLET',[{dishId:'com-tam',quantity:1}]));
 const envelope=lost.envelope!, invoice=envelope.invoice;
 const quote=await contracts.CampusPaymentRegistry.quoteInvoice(invoice,account);
 const lostTx=await contracts.CampusPaymentRegistry.connect(student).payInvoice(invoice,envelope.signature,{value:quote.paidAmount});
 const lostReceipt=await lostTx.wait();assert.equal(lostReceipt.status,1);
 assert.equal(repo.get(lost.order.id,account).txHash,null);
 assert.equal(repo.get(lost.order.id,account).status,'AWAITING_PAYMENT');
 const nonceBefore=await provider.getTransactionCount(account);
 const creationsBefore=invoiceCreations;
 const app=express(), origin='http://localhost:3000';
 app.use(createCanteenRouter(service,
  {session:(token:string)=>token==='demo'?{account:{wallet:account,role:'STUDENT'}}:null} as unknown as AuthService,
  {cookieName:'session',origin} as LibraryAuthConfig,
  {accountStatus:async()=>({held:true})} as unknown as LibraryService));
 const server=createServer(app).listen(0,'127.0.0.1');await once(server,'listening');
 let recovery;
 try {
  const address=server.address();assert(address&&typeof address!=='string');
  const post=(path:string,body:unknown={})=>fetch(`http://127.0.0.1:${address.port}/api/canteen/${path}`,{
   method:'POST',headers:{'content-type':'application/json',Origin:origin,Cookie:'session=demo'},body:JSON.stringify(body)});
  const response=await post(`orders/${lost.order.id}/prepare`);assert.equal(response.status,200);
  recovery=await response.json();assert.equal(recovery.order.status,'PAID');assert.equal(recovery.order.txHash,lostTx.hash);
  assert.equal(recovery.order.invoiceId,lost.order.invoiceId);assert.equal(recovery.envelope,null);
  const repeated=await post(`orders/${lost.order.id}/prepare`);assert.equal(repeated.status,200);assert.deepEqual(await repeated.json(),recovery);
  const unpaid=repo.create(account,'held-unpaid','WALLET',[{dishId:'com-tam',quantity:1}]);
  assert.equal((await post(`orders/${unpaid.id}/prepare`)).status,403);
  assert.equal((await post('orders',{method:'WALLET',items:[{dishId:'com-tam',quantity:1}],idempotencyKey:'11111111-1111-4111-8111-111111111111'})).status,403);
  const wrong=repo.create(account,'other-order','WALLET',[{dishId:'com-tam',quantity:1}]);repo.prepare(wrong.id,account,lostReceipt.blockNumber,id('other-invoice'));
  assert.equal((await post(`orders/${wrong.id}/transactions`,{txHash:lostTx.hash})).status,422);
  assert.equal(repo.get(wrong.id,account).status,'AWAITING_PAYMENT');
  assert.equal(invoiceCreations,creationsBefore);assert.equal(await provider.getTransactionCount(account),nonceBefore);
 } finally {server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
 cases.push({method:'WALLET_HELD_RECOVERY',scope:'Real Anvil payment and receipt; HTTP auth and held=true flag are fixtures',
  orderId:lost.order.id,invoiceId:lost.order.invoiceId,txHash:lostTx.hash,receipt:{status:lostReceipt.status,blockNumber:lostReceipt.blockNumber,blockHash:lostReceipt.blockHash,
   logs:lostReceipt.logs.map((log:{address:string;topics:readonly string[];data:string})=>({address:log.address,topics:log.topics,data:log.data}))},
  before:{status:'AWAITING_PAYMENT',txHash:null},after:recovery.order,additionalInvoiceCreations:invoiceCreations-creationsBefore,
  nonceBefore,nonceAfter:await provider.getTransactionCount(account)});
 writeFileSync(output,JSON.stringify({environment:'local-anvil',chainId:20261,scope:'Real EVM, current source-verified contracts and canteen services. Not Core or Avalanche L1 acceptance.',cases},null,2)+'\n');console.log('PASS: WALLET SBT 1000 -> 900; FOOD 5000 -> 4000; merchant credited; held paid order recovered without new invoice or transaction.');
}finally{grants?.close();repo.close();invoices.close();provider.destroy();}
