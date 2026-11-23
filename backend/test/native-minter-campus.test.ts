import assert from "node:assert/strict";
import test from "node:test";
import { Interface, Wallet } from "ethers";
import { CampusRepository } from "../src/modules/campus/campus.repository.ts";
import { CampusService } from "../src/modules/campus/campus.service.ts";
import { NativeMinterService, NATIVE_MINTER_ADDRESS, WELCOME_MINT_WEI } from "../src/modules/native-minter/native-minter.service.ts";
import type { AdminRpcClient } from "../src/modules/admin/admin.signer.ts";

const school = Wallet.createRandom();
const student = Wallet.createRandom();
const funder = Wallet.createRandom();
const txHash = `0x${"a1".repeat(32)}`;
const block64 = `0x${"64".repeat(32)}`;
const block65 = `0x${"65".repeat(32)}`;
const chainIdHex = `0x${BigInt(20261120).toString(16)}`;
const precompile = new Interface([
  "function readAllowList(address) view returns (uint256 role)",
  "function mintNativeCoin(address addr,uint256 amount)",
  "event NativeCoinMinted(address indexed sender,address indexed recipient,uint256 amount)",
]);

function setup(initialRole: bigint) {
  const state: { role: bigint; tx: Record<string, unknown> | null; receipt: Record<string, unknown> | null; sends: number } = {
    role: initialRole, tx: null, receipt: null, sends: 0,
  };
  const minterRpc: AdminRpcClient = {
    async chainId() { return 20261120n; },
    async latestBlock() { return { number: 101, timestamp: Math.floor(Date.now() / 1000) }; },
    async getBalance() { return 10n ** 21n; },
    async call(to, data) {
      assert.equal(to.toLowerCase(), NATIVE_MINTER_ADDRESS.toLowerCase());
      const parsed = precompile.parseTransaction({ data });
      assert.equal(parsed?.name, "readAllowList");
      return precompile.encodeFunctionResult("readAllowList", [state.role]);
    },
    async sendSignedTransaction(input) {
      state.sends += 1;
      assert.equal(input.to.toLowerCase(), NATIVE_MINTER_ADDRESS.toLowerCase());
      assert.equal(input.valueWei, 0n);
      const [recipient, amount] = precompile.decodeFunctionData("mintNativeCoin", input.data);
      assert.equal(String(recipient).toLowerCase(), student.address.toLowerCase());
      assert.equal(BigInt(amount), WELCOME_MINT_WEI);
      await input.beforeBroadcast?.(txHash);
      const log = precompile.encodeEventLog(precompile.getEvent("NativeCoinMinted")!, [funder.address, student.address, WELCOME_MINT_WEI]);
      state.tx = { hash: txHash, from: funder.address, to: NATIVE_MINTER_ADDRESS, input: input.data, value: "0x0", chainId: chainIdHex, blockNumber: "0x65", blockHash: block65 };
      state.receipt = { transactionHash: txHash, status: "0x1", blockNumber: "0x65", blockHash: block65,
        logs: [{ address: NATIVE_MINTER_ADDRESS, transactionHash: txHash, blockNumber: "0x65", blockHash: block65, ...log }] };
      return { txHash, from: funder.address };
    },
    async getTransactionStatus(hash) {
      if (!state.receipt) return { txHash: hash, status: "SUBMITTED", blockNumber: null, blockHash: null };
      return { txHash: hash, status: "CONFIRMED", blockNumber: 101, blockHash: block65 };
    },
    async getTransactionReceipt() { return state.receipt; },
    async getTransaction() { return state.tx; },
    async getBlock(number) { return { number, hash: block65 }; },
  };
  const campusRpc = {
    async call(method: string, params: unknown[]) {
      if (method === "eth_chainId") return chainIdHex;
      if (method === "eth_getBlockByNumber") {
        const number = params[0];
        if (number === "latest") return state.receipt
          ? { number: "0x65", hash: block65, timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` }
          : { number: "0x64", hash: block64, timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` };
        return number === "0x64" ? { number, hash: block64 } : { number: "0x65", hash: block65 };
      }
      if (method === "eth_getTransactionReceipt") return state.receipt;
      if (method === "eth_getTransactionByHash") return state.tx;
      throw Error(`unexpected RPC method ${method}`);
    },
  };
  const repository = new CampusRepository(":memory:");
  const service = new CampusService(repository, {
    NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID: "20261120",
    CAMPUS_AUTH_ORIGIN: "https://campus.example",
    CAMPUS_SCHOOL_WALLETS: school.address,
  }, campusRpc as never, undefined, undefined, new NativeMinterService({
    rpc: minterRpc, signerPrivateKey: funder.privateKey, chainId: 20261120,
  }));
  repository.submit(student.address.toLowerCase(), "DEMO-1001", "CNTT");
  return { repository, service, state };
}

test("approving a cloud student automatically mints one verified 20 CAMPUS welcome grant", async () => {
  const { repository, service, state } = setup(1n);
  try {
    const result = await service.review(school.address.toLowerCase(), student.address, "STUDENT", true, "VERIFIED");
    assert.equal(result.welcomeMint?.status, "CONFIRMED");
    assert.equal(result.profile.payouts[0]?.executionType, "NATIVE_MINT");
    assert.equal(result.profile.payouts[0]?.status, "CONFIRMED");
    assert.equal(result.profile.payouts[0]?.mintAmountWei, WELCOME_MINT_WEI.toString());
    assert.equal(state.sends, 1);
    assert.equal((await service.issueWelcome(student.address)).status, "CONFIRMED");
    assert.equal(state.sends, 1, "repeated issue checks the existing payout without sending another mint");
    await assert.rejects(service.prepare(school.address.toLowerCase(), student.address, "WELCOME"), /ADMIN_BACKFILL_REQUIRED/);
  } finally { repository.close(); }
});

test("missing Native Minter role blocks mint on approval and permits explicit issuance after role is granted", async () => {
  const { repository, service, state } = setup(0n);
  try {
    const result = await service.review(school.address.toLowerCase(), student.address, "STUDENT", true, "VERIFIED");
    assert.equal(result.welcomeMint?.status, "NOT_READY");
    assert.equal(result.profile.payouts.length, 0);
    assert.equal(state.sends, 0);
    state.role = 1n;
    const payout = await service.issueWelcome(student.address);
    assert.equal(payout.status, "CONFIRMED");
    assert.equal(state.sends, 1);
  } finally { repository.close(); }
});

test("Native Minter receipt must include its matching canonical event", async () => {
  const { repository, service, state } = setup(1n);
  try {
    const result = await service.review(school.address.toLowerCase(), student.address, "STUDENT", true, "VERIFIED");
    assert.equal(result.welcomeMint?.status, "CONFIRMED");
    const payout = result.profile.payouts[0]!;
    state.receipt!.logs = [];
    await assert.rejects(service.reconcile(payout.id, txHash), /RECEIPT_MISMATCH/);
  } finally { repository.close(); }
});
