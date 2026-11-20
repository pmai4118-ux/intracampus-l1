import { CAMPUS_CHAIN_ID } from "@intracampus/network";
import { FetchRequest, JsonRpcProvider, type Block, type Filter, type Log, type TransactionReceipt, type TransactionResponse } from "ethers";

export type LibraryRpcClient = {
  getNetwork(): Promise<{ chainId: bigint }>;
  getBlock(blockTag: "latest" | number): Promise<Block | null>;
  getLogs(filter: Filter): Promise<Log[]>;
  getTransaction(hash: string): Promise<TransactionResponse | null>;
  getTransactionReceipt(hash: string): Promise<TransactionReceipt | null>;
  getCode(address: string, blockTag?: number): Promise<string>;
  call(transaction: { to: string; data: string }, blockTag?: number): Promise<string>;
  destroy?(): void;
};

export class LibraryRpcError extends Error {
  readonly code: "RPC_UNAVAILABLE" | "WRONG_CHAIN";
  constructor(code: "RPC_UNAVAILABLE" | "WRONG_CHAIN" = "RPC_UNAVAILABLE") {
    super(code);
    this.code = code;
  }
}

export class HttpLibraryRpc implements LibraryRpcClient {
  readonly provider: JsonRpcProvider;
  constructor(url: string) {
    try {
      const parsed = new URL(url);
      if (!(parsed.protocol === "https:" || parsed.protocol === "http:") || parsed.username || parsed.password) throw new Error();
      const request = new FetchRequest(parsed.href);
      request.timeout = 5000;
      this.provider = new JsonRpcProvider(request, CAMPUS_CHAIN_ID, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 100 });
    } catch { throw new LibraryRpcError(); }
  }
  async getNetwork(): Promise<{ chainId: bigint }> {
    let chainId: unknown;
    try { chainId = await this.provider.send("eth_chainId", []); }
    catch { throw new LibraryRpcError("RPC_UNAVAILABLE"); }
    if (typeof chainId !== "string" || !/^0x[0-9a-f]+$/i.test(chainId)) throw new LibraryRpcError("RPC_UNAVAILABLE");
    try { return { chainId: BigInt(chainId) }; }
    catch { throw new LibraryRpcError("RPC_UNAVAILABLE"); }
  }
  getBlock(blockTag: "latest" | number) { return this.provider.getBlock(blockTag); }
  getLogs(filter: Filter) { return this.provider.getLogs(filter); }
  getTransaction(hash: string) { return this.provider.getTransaction(hash); }
  getTransactionReceipt(hash: string) { return this.provider.getTransactionReceipt(hash); }
  getCode(address: string, blockTag?: number) { return this.provider.getCode(address, blockTag); }
  call(transaction: { to: string; data: string }, blockTag?: number) {
    return this.provider.send("eth_call", [transaction, blockTag === undefined ? "latest" : `0x${blockTag.toString(16)}`]);
  }
  destroy() { this.provider.destroy(); }
}
