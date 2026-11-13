import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import type { TestContext } from "node:test";
import { Interface, JsonRpcProvider, keccak256 } from "ethers";
import { requireDeployment } from "@intracampus/network";
import template from "../../deployments/intracampus.json" with { type: "json" };

export const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
export const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
export const beneficiary = address(30);
export const txHash = hash(90);
export const code = "0x60006000";
export const FOOD = "0x2f6f5a261d6f4514c3f09a834720fe583c82f2ee4758ce9a45fbd67428e9f93d";
export const PARKING = "0xe3415db38bf7529604e320f58333c9ff6b278ff38b3391db9da4273c7be086eb";

// ABI comes from the public template; the remaining metadata is synthetic RPC evidence only.
export function manifest() {
  return requireDeployment({ ...structuredClone(template), status: "deployed", environment: "local-anvil",
    contracts: Object.fromEntries(Object.entries(template.contracts).map(([name, contract], i) => [name, {
      ...contract, address: address(i + 1), transactionHash: hash(i + 1), blockNumber: i + 1,
      blockHash: hash(i + 1), runtimeCodeHash: keccak256(code),
    }])),
    roles: { deployer: address(10), sbtIssuer: address(10), grantIssuer: address(10), posSigner: address(11) },
    merchants: { parking: { address: address(20), category: PARKING }, canteen: { address: address(21), category: FOOD } },
  }, { allowLocal: true });
}

export async function serve(t: TestContext, handler: RequestListener) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const endpoint = server.address();
  assert(endpoint && typeof endpoint !== "string");
  return `http://127.0.0.1:${endpoint.port}`;
}

export class GrantRpcFixture {
  deployment = manifest();
  vault = new Interface(this.deployment.contracts.PurposeBoundGrantVault.abi);
  registry = new Interface(this.deployment.contracts.CampusPaymentRegistry.abi);
  chainId = "0x4f25";
  balance = 0n;
  allowed = true;
  issuer = address(10);
  registryAddress = address(2);
  runtime = code;
  reset = false;
  unavailable = false;
  receipt: Record<string, unknown> | null = null;
  logs: Record<string, unknown>[] = [];
  calls: { method: string; params: unknown[] }[] = [];

  event(name: "GrantIssued" | "GrantSpent", overrides: Record<string, unknown> = {}) {
    const fragment = this.vault.getEvent(name);
    assert(fragment);
    const values = name === "GrantIssued" ? [beneficiary, FOOD, address(10), 5000n, 5000n]
      : [beneficiary, address(21), FOOD, 1000n, 4000n];
    return { address: address(3), ...this.vault.encodeEventLog(fragment, values), transactionHash: txHash,
      blockNumber: "0xa", blockHash: hash(10), logIndex: "0x0", transactionIndex: "0x0", removed: false, ...overrides };
  }
  settle(name: "GrantIssued" | "GrantSpent" = "GrantIssued") {
    const event = this.event(name);
    this.logs = [event];
    this.receipt = { transactionHash: txHash, blockNumber: "0xa", blockHash: hash(10), to: address(3),
      from: name === "GrantIssued" ? address(10) : beneficiary, status: "0x1", transactionIndex: "0x0", logs: [event] };
  }
  call(method: string, params: unknown[]): unknown {
    this.calls.push({ method, params });
    if (this.unavailable) throw new Error("secret RPC https://token:password@example.invalid");
    if (method === "eth_chainId") return this.chainId;
    if (method === "eth_blockNumber") return "0xa";
    if (method === "eth_getBlockByNumber") {
      const n = params[0] === "latest" ? 10 : Number(params[0]);
      return { number: `0x${n.toString(16)}`, hash: this.reset && n < 4 ? hash(999) : hash(n),
        transactions: this.receipt && Number(this.receipt.blockNumber) === n ? [this.receipt.transactionHash] : [] };
    }
    if (method === "eth_getCode") return this.runtime;
    if (method === "eth_getTransactionReceipt") return this.receipt;
    if (method === "eth_getLogs") {
      const filter = params[0] as { fromBlock: string; toBlock: string };
      return this.logs.filter((log) => Number(log.blockNumber) >= Number(filter.fromBlock) && Number(log.blockNumber) <= Number(filter.toBlock));
    }
    if (method === "eth_call") {
      const transaction = params[0] as { to: string; data: string };
      const abi = transaction.to.toLowerCase() === address(2) ? this.registry : this.vault;
      const parsed = abi.parseTransaction({ data: transaction.data });
      assert(parsed);
      const results: Record<string, unknown> = { issuer: this.issuer, merchantRegistry: this.registryAddress,
        balances: this.balance, allowedMerchantCategories: this.allowed };
      assert(Object.hasOwn(results, parsed.name), parsed.name);
      return abi.encodeFunctionResult(parsed.fragment, [results[parsed.name]]);
    }
    throw new Error(`Unexpected method ${method}`);
  }
}

export async function rpcFixture(t: TestContext) {
  const rpc = new GrantRpcFixture();
  const url = await serve(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString());
    let payload;
    try { payload = { jsonrpc: "2.0", id, result: rpc.call(method, params) }; }
    catch (error) { payload = { jsonrpc: "2.0", id, error: { code: -32000, message: String(error) } }; }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(payload));
  });
  const provider = new JsonRpcProvider(url, 20261, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
  t.after(() => provider.destroy());
  return { rpc, url, provider };
}
