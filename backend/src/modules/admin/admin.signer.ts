import { FetchRequest, JsonRpcProvider, Wallet, keccak256 } from "ethers";
import { CAMPUS_CHAIN_ID, type AdminTxStatus } from "@intracampus/network";

export type AdminRpcClient = {
  chainId(): Promise<bigint>;
  latestBlock(): Promise<{ number: number; timestamp: number } | null>;
  getBalance(address: string): Promise<bigint>;
  call(to: string, data: string): Promise<string>;
  sendSignedTransaction(input: {
    privateKey: string;
    to: string;
    data: string;
    valueWei?: bigint;
    beforeBroadcast?: (txHash: string) => Promise<void> | void;
  }): Promise<{ txHash: string; from: string }>;
  getTransactionStatus(txHash: string): Promise<AdminTxStatus>;
  getTransactionReceipt?(txHash: string): Promise<unknown | null>;
  getTransaction?(txHash: string): Promise<unknown | null>;
  getBlock?(blockNumber: string): Promise<unknown | null>;
  waitForReceipt?(txHash: string, timeoutMs?: number): Promise<AdminTxStatus>;
  close?(): void;
};

export class AdminChainError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, httpStatus = 503) {
    super(code);
    this.name = "AdminChainError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class JsonRpcAdminClient implements AdminRpcClient {
  private readonly provider: JsonRpcProvider;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(rpcUrl: string) {
    const parsed = new URL(rpcUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new AdminChainError("RPC_UNAVAILABLE", 503);
    }
    const request = new FetchRequest(parsed.href);
    request.timeout = 8000;
    this.provider = new JsonRpcProvider(request, CAMPUS_CHAIN_ID, {
      staticNetwork: true,
      cacheTimeout: -1,
      batchMaxCount: 1,
    });
  }

  close(): void {
    this.provider.destroy();
  }

  async chainId(): Promise<bigint> {
    try {
      const raw = await this.provider.send("eth_chainId", []);
      return BigInt(String(raw));
    } catch {
      throw new AdminChainError("RPC_UNAVAILABLE", 503);
    }
  }

  async latestBlock(): Promise<{ number: number; timestamp: number } | null> {
    try {
      const block = await this.provider.send("eth_getBlockByNumber", ["latest", false]) as
        | { number?: string; timestamp?: string }
        | null;
      if (!block?.number || !block.timestamp) return null;
      return { number: Number(BigInt(block.number)), timestamp: Number(BigInt(block.timestamp)) };
    } catch {
      return null;
    }
  }

  async getBalance(address: string): Promise<bigint> {
    try {
      const raw = await this.provider.send("eth_getBalance", [address, "latest"]);
      return BigInt(String(raw));
    } catch {
      throw new AdminChainError("RPC_UNAVAILABLE", 503);
    }
  }

  async call(to: string, data: string): Promise<string> {
    try {
      const raw = await this.provider.send("eth_call", [{ to, data }, "latest"]);
      if (typeof raw !== "string") throw new Error();
      return raw;
    } catch {
      throw new AdminChainError("RPC_UNAVAILABLE", 503);
    }
  }

  async sendSignedTransaction(input: {
    privateKey: string;
    to: string;
    data: string;
    valueWei?: bigint;
    beforeBroadcast?: (txHash: string) => Promise<void> | void;
  }): Promise<{ txHash: string; from: string }> {
    const wallet = new Wallet(input.privateKey);
    const key = wallet.address.toLowerCase();
    const prior = this.queues.get(key) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(async () => {
      const actualChainId = await this.chainId();
      if (actualChainId !== BigInt(CAMPUS_CHAIN_ID)) {
        throw new AdminChainError("WRONG_CHAIN", 503);
      }
      const value = input.valueWei ?? 0n;
      const [nonceHex, gasPriceHex] = await Promise.all([
        this.provider.send("eth_getTransactionCount", [wallet.address, "pending"]),
        this.provider.send("eth_gasPrice", []),
      ]);
      const nonce = Number(BigInt(String(nonceHex)));
      const gasPrice = BigInt(String(gasPriceHex));
      let gasLimit: bigint;
      try {
        const estimated = BigInt(String(await this.provider.send("eth_estimateGas", [{
          from: wallet.address,
          to: input.to,
          data: input.data,
          value: `0x${value.toString(16)}`,
        }])));
        gasLimit = (estimated * 125n) / 100n + 10_000n;
      } catch {
        throw new AdminChainError("TX_SIMULATION_FAILED", 422);
      }
      const balance = await this.getBalance(wallet.address);
      if (balance < value + gasLimit * gasPrice) {
        throw new AdminChainError("SIGNER_INSUFFICIENT_FUNDS", 409);
      }
      const signed = await wallet.signTransaction({
        type: 0,
        chainId: CAMPUS_CHAIN_ID,
        nonce,
        to: input.to,
        data: input.data,
        value,
        gasLimit,
        gasPrice,
      });
      const expectedHash = keccak256(signed).toLowerCase();
      try {
        await input.beforeBroadcast?.(expectedHash);
      } catch {
        throw new AdminChainError("TX_PERSIST_FAILED", 503);
      }
      try {
        const hash = String(await this.provider.send("eth_sendRawTransaction", [signed])).toLowerCase();
        if (hash !== expectedHash) throw new AdminChainError("TX_HASH_MISMATCH", 503);
        return { txHash: hash, from: wallet.address };
      } catch {
        throw new AdminChainError("TX_BROADCAST_FAILED", 503);
      }
    });
    this.queues.set(key, run);
    try {
      return await run;
    } finally {
      if (this.queues.get(key) === run) this.queues.delete(key);
    }
  }

  async getTransactionStatus(txHash: string): Promise<AdminTxStatus> {
    let raw: unknown;
    try {
      raw = await this.provider.send("eth_getTransactionReceipt", [txHash]);
    } catch {
      throw new AdminChainError("RPC_UNAVAILABLE", 503);
    }
    if (!raw || typeof raw !== "object") {
      return { txHash: txHash.toLowerCase(), status: "SUBMITTED", blockNumber: null, blockHash: null };
    }
    const receipt = raw as { status?: string; blockNumber?: string; blockHash?: string };
    const ok = receipt.status === "0x1" || receipt.status === "0x01";
    const blockNumber = receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : null;
    const blockHash = receipt.blockHash ? String(receipt.blockHash).toLowerCase() : null;
    return {
      txHash: txHash.toLowerCase(),
      status: ok ? "CONFIRMED" : "FAILED",
      blockNumber,
      blockHash,
    };
  }

  async getTransactionReceipt(txHash: string): Promise<unknown | null> {
    try {
      return await this.provider.send("eth_getTransactionReceipt", [txHash]) as unknown | null;
    } catch {
      throw new AdminChainError("RPC_UNAVAILABLE", 503);
    }
  }

  async getTransaction(txHash: string): Promise<unknown | null> {
    try {
      return await this.provider.send("eth_getTransactionByHash", [txHash]) as unknown | null;
    } catch {
      throw new AdminChainError("RPC_UNAVAILABLE", 503);
    }
  }

  async getBlock(blockNumber: string): Promise<unknown | null> {
    try {
      return await this.provider.send("eth_getBlockByNumber", [blockNumber, false]) as unknown | null;
    } catch {
      throw new AdminChainError("RPC_UNAVAILABLE", 503);
    }
  }

  async waitForReceipt(txHash: string, timeoutMs = 8_000): Promise<AdminTxStatus> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const current = await this.getTransactionStatus(txHash);
      if (current.status !== "SUBMITTED" || Date.now() >= deadline) {
        return current;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}
