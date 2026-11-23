import assert from "node:assert/strict";
import test from "node:test";
import { Interface, Wallet } from "ethers";
import { NativeMinterService, NATIVE_MINTER_ADDRESS } from "../src/modules/native-minter/native-minter.service.ts";

const signer = Wallet.createRandom();
const recipient = Wallet.createRandom().address;
const hash = `0x${"ab".repeat(32)}`;
const iface = new Interface(["function readAllowList(address) view returns (uint256 role)"]);

function setup(role: bigint, chainId = 20261120n) {
  const sent: Array<Record<string, unknown>> = [];
  const rpc = {
    async chainId() { return chainId; },
    async latestBlock() { return { number: 50, timestamp: Math.floor(Date.now() / 1000) }; },
    async getBalance() { return 10n ** 21n; },
    async call(_to: string, data: string) {
      assert.equal(_to.toLowerCase(), NATIVE_MINTER_ADDRESS.toLowerCase());
      return iface.encodeFunctionResult("readAllowList", [role]);
    },
    async sendSignedTransaction(input: Record<string, unknown>) {
      sent.push(input);
      await (input.beforeBroadcast as ((txHash: string) => Promise<void>) | undefined)?.(hash);
      return { txHash: hash, from: signer.address };
    },
    async getTransactionStatus() { return { txHash: hash, status: "SUBMITTED" as const, blockNumber: null, blockHash: null }; },
  };
  return { service: new NativeMinterService({ rpc, signerPrivateKey: signer.privateKey, chainId: 20261120 }), sent };
}

test("Native Minter readiness requires a mint-capable role on the cloud chain", async () => {
  const denied = setup(0n);
  assert.equal((await denied.service.readiness()).role, 0);
  assert.equal((await denied.service.readiness()).ready, false);
  await assert.rejects(denied.service.mint({ recipient, amountWei: 20n * 10n ** 18n }), /NATIVE_MINTER_ROLE_MISSING/);
  assert.equal(denied.sent.length, 0);

  const allowed = setup(1n);
  const readiness = await allowed.service.readiness();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.signerAddress?.toLowerCase(), signer.address.toLowerCase());
});

test("Native Minter signs only a bounded mint and persists the hash before broadcast", async () => {
  const { service, sent } = setup(1n);
  const order: string[] = [];
  const result = await service.mint({
    recipient,
    amountWei: 20n * 10n ** 18n,
    beforeBroadcast: async txHash => { order.push(`persist:${txHash}`); },
  });
  assert.equal(result.txHash, hash);
  assert.equal(result.amountWei, 20n * 10n ** 18n);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, NATIVE_MINTER_ADDRESS);
  assert.equal(sent[0].valueWei, 0n);
  assert.equal(order[0], `persist:${hash}`);
});

test("Native Minter rejects local-chain use and amounts above the app cap", async () => {
  const wrongChain = setup(1n, 20261n);
  await assert.rejects(wrongChain.service.mint({ recipient, amountWei: 1n }), /WRONG_CHAIN/);
  await assert.rejects(wrongChain.service.verifyMint(hash, { recipient, amountWei: 1n }), /WRONG_CHAIN/);
  const allowed = setup(1n);
  await assert.rejects(allowed.service.mint({ recipient, amountWei: 100_001n * 10n ** 18n }), /AMOUNT_LIMIT/);
  assert.equal(allowed.sent.length, 0);
});
