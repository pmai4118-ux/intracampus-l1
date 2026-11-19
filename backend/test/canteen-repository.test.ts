import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanteenRepository } from '../src/modules/canteen/canteen.repository.ts';
const wallet='0x'+'12'.repeat(20), other='0x'+'34'.repeat(20), key='11111111-1111-4111-8111-111111111111';
test('seed is repeatable; snapshots, idempotency and paid proof survive reopen',()=>{
 const file=join(mkdtempSync(join(tmpdir(),'canteen-')),'canteen.sqlite');let repo=new CanteenRepository(file);repo.seed();repo.seed();assert.equal(repo.menu().length,3);
 const order=repo.create(wallet,key,'FOOD',[{dishId:'com-tam',quantity:2},{dishId:'pho-bo',quantity:1}]);assert.equal(order.totalWei,(58n*10n**18n).toString());
 assert.equal(repo.create(wallet,key,'FOOD',[{dishId:'pho-bo',quantity:1},{dishId:'com-tam',quantity:2}]).id,order.id);
 assert.throws(()=>repo.create(wallet,key,'WALLET',[{dishId:'com-tam',quantity:1}]),/IDEMPOTENCY_CONFLICT/);
 assert.throws(()=>repo.get(order.id,other),/NOT_FOUND/);
 repo.prepare(order.id,wallet,42,null);repo.confirm(order.id,wallet,'0x'+'ab'.repeat(32),order.totalWei);repo.close();repo=new CanteenRepository(file);repo.seed();
 assert.equal(repo.get(order.id,wallet).status,'PAID');assert.equal(repo.list(wallet).length,1);repo.close();
});
test('a transaction cannot pay two orders or replace another tracked hash',()=>{
 const repo=new CanteenRepository(':memory:');repo.seed();
 const a=repo.create(wallet,key,'FOOD',[{dishId:'com-tam',quantity:1}]);const b=repo.create(wallet,key+'b','FOOD',[{dishId:'com-tam',quantity:1}]);
 repo.prepare(a.id,wallet,4,null);repo.prepare(b.id,wallet,4,null);repo.claim(a.id,wallet,'hash1');
 assert.throws(()=>repo.claim(b.id,wallet,'hash1'),/PAYMENT_ALREADY_USED/);assert.throws(()=>repo.claim(a.id,wallet,'hash2'),/PAYMENT_ALREADY_TRACKED/);repo.close();
});
