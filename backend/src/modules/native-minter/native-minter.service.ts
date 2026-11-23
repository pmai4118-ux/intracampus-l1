import { Interface, Wallet, getAddress } from "ethers";
import { CLOUD_CAMPUS_CHAIN_ID, type AdminTxStatus } from "@intracampus/network";
import { AdminChainError, JsonRpcAdminClient, type AdminRpcClient } from "../admin/admin.signer.ts";

export const NATIVE_MINTER_ADDRESS = "0x0200000000000000000000000000000000000001";
export const MAX_ADMIN_MINT_WEI = 100_000n * 10n ** 18n;
export const WELCOME_MINT_WEI = 20n * 10n ** 18n;

const nativeMinterAbi = new Interface([
  "function readAllowList(address addr) view returns (uint256 role)",
  "function mintNativeCoin(address addr,uint256 amount)",
  "event NativeCoinMinted(address indexed sender,address indexed recipient,uint256 amount)",
]);

export type NativeMinterReadiness = {
  supported: boolean;
  ready: boolean;
  chainId: number | null;
  signerAddress: string | null;
  role: number | null;
  reason: string | null;
};

export class NativeMinterError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, httpStatus = 503) {
    super(code);
    this.name = "NativeMinterError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export type NativeMinterDependencies = {
  rpc?: AdminRpcClient;
  rpcUrl?: string;
  signerPrivateKey?: string;
  getSignerPrivateKey?: () => string | undefined;
  chainId?: number;
};

export class NativeMinterService {
  private rpc?: AdminRpcClient;
  private ownsRpc = false;
  private readonly rpcUrl?: string;
  private readonly signerPrivateKey?: string;
  private readonly getSignerPrivateKey?: () => string | undefined;
  private readonly chainId: number;

  constructor(deps: NativeMinterDependencies = {}) {
    this.rpc = deps.rpc;
    this.rpcUrl = deps.rpcUrl;
    this.signerPrivateKey = deps.signerPrivateKey;
    this.getSignerPrivateKey = deps.getSignerPrivateKey;
    this.chainId = deps.chainId ?? CLOUD_CAMPUS_CHAIN_ID;
  }

  close() {
    if (this.ownsRpc) this.rpc?.close?.();
    this.rpc = undefined;
  }

  private getRpc(): AdminRpcClient | undefined {
    if (this.rpc) return this.rpc;
    if (!this.rpcUrl) return undefined;
    try {
      this.rpc = new JsonRpcAdminClient(this.rpcUrl);
      this.ownsRpc = true;
      return this.rpc;
    } catch {
      return undefined;
    }
  }

  private key() { return this.getSignerPrivateKey?.() ?? this.signerPrivateKey; }

  async readiness(): Promise<NativeMinterReadiness> {
    const rpc = this.getRpc();
    const key = this.key();
    const signerAddress = key ? new Wallet(key).address : null;
    if (this.chainId !== CLOUD_CAMPUS_CHAIN_ID) return { supported: false, ready: false, chainId: this.chainId, signerAddress, role: null, reason: "CLOUD_CHAIN_REQUIRED" };
    if (!rpc) return { supported: true, ready: false, chainId: null, signerAddress, role: null, reason: "RPC_NOT_CONFIGURED" };
    if (!key) return { supported: true, ready: false, chainId: CLOUD_CAMPUS_CHAIN_ID, signerAddress: null, role: null, reason: "SIGNER_NOT_CONFIGURED" };
    try {
      const chainId = await rpc.chainId();
      if (chainId !== BigInt(CLOUD_CAMPUS_CHAIN_ID)) return { supported: true, ready: false, chainId: Number(chainId), signerAddress, role: null, reason: "WRONG_CHAIN" };
      const raw = await rpc.call(NATIVE_MINTER_ADDRESS, nativeMinterAbi.encodeFunctionData("readAllowList", [signerAddress]));
      const role = Number(nativeMinterAbi.decodeFunctionResult("readAllowList", raw)[0]);
      return { supported: true, ready: role > 0 && role <= 3, chainId: CLOUD_CAMPUS_CHAIN_ID, signerAddress, role,
        reason: role > 0 && role <= 3 ? null : "NATIVE_MINTER_ROLE_MISSING" };
    } catch {
      return { supported: true, ready: false, chainId: CLOUD_CAMPUS_CHAIN_ID, signerAddress, role: null, reason: "RPC_UNAVAILABLE" };
    }
  }

  async mint(input: {
    recipient: string;
    amountWei: bigint;
    beforeBroadcast?: (txHash: string) => Promise<void> | void;
    maxAmountWei?: bigint;
  }): Promise<{ txHash: string; from: string; recipient: string; amountWei: bigint }> {
    let recipient: string;
    try {
      recipient = getAddress(input.recipient);
      if (/^0x0{40}$/i.test(recipient)) throw new Error();
    } catch {
      throw new NativeMinterError("INVALID_ADDRESS", 400);
    }
    if (this.chainId !== CLOUD_CAMPUS_CHAIN_ID) throw new NativeMinterError("CLOUD_CHAIN_REQUIRED", 409);
    const maxAmountWei = input.maxAmountWei ?? MAX_ADMIN_MINT_WEI;
    if (input.amountWei <= 0n || input.amountWei > maxAmountWei || input.amountWei >= 2n ** 256n) {
      throw new NativeMinterError("AMOUNT_LIMIT", 400);
    }
    const readiness = await this.readiness();
    if (readiness.reason === "SIGNER_NOT_CONFIGURED") throw new NativeMinterError("SIGNER_NOT_CONFIGURED", 503);
    if (readiness.reason === "RPC_NOT_CONFIGURED" || readiness.reason === "RPC_UNAVAILABLE") throw new NativeMinterError("RPC_UNAVAILABLE", 503);
    if (readiness.reason === "WRONG_CHAIN") throw new NativeMinterError("WRONG_CHAIN", 503);
    if (!readiness.ready || !readiness.signerAddress) throw new NativeMinterError("NATIVE_MINTER_ROLE_MISSING", 409);
    const rpc = this.getRpc();
    const privateKey = this.key();
    if (!rpc || !privateKey) throw new NativeMinterError("SIGNER_NOT_CONFIGURED", 503);
    try {
      const sent = await rpc.sendSignedTransaction({
        privateKey,
        to: NATIVE_MINTER_ADDRESS,
        data: nativeMinterAbi.encodeFunctionData("mintNativeCoin", [recipient, input.amountWei]),
        valueWei: 0n,
        beforeBroadcast: input.beforeBroadcast,
      });
      return { ...sent, recipient, amountWei: input.amountWei };
    } catch (error) {
      if (error instanceof NativeMinterError) throw error;
      if (error instanceof AdminChainError) throw new NativeMinterError(error.code, error.httpStatus);
      throw new NativeMinterError("INTERNAL_ERROR", 500);
    }
  }

  async verifyMint(txHash: string, expected: { recipient: string; amountWei: bigint }): Promise<AdminTxStatus> {
    if (!/^0x[0-9a-f]{64}$/i.test(txHash) || /^0x0{64}$/i.test(txHash)) throw new NativeMinterError("INVALID_HASH", 400);
    const rpc = this.getRpc();
    const readiness = await this.readiness();
    if (!rpc || !readiness.signerAddress) throw new NativeMinterError("SIGNER_NOT_CONFIGURED", 503);
    if (readiness.reason === "WRONG_CHAIN" || readiness.chainId !== CLOUD_CAMPUS_CHAIN_ID) throw new NativeMinterError("WRONG_CHAIN", 503);
    if (readiness.reason === "RPC_UNAVAILABLE" || readiness.reason === "RPC_NOT_CONFIGURED") throw new NativeMinterError("RPC_UNAVAILABLE", 503);
    if (!rpc.getTransactionReceipt || !rpc.getTransaction || !rpc.getBlock) throw new NativeMinterError("RPC_UNAVAILABLE", 503);
    let status: AdminTxStatus;
    try { status = await rpc.getTransactionStatus(txHash); }
    catch { throw new NativeMinterError("RPC_UNAVAILABLE", 503); }
    if (status.status === "SUBMITTED") return status;
    let receiptRaw: unknown, txRaw: unknown;
    try {
      [receiptRaw, txRaw] = await Promise.all([rpc.getTransactionReceipt(txHash), rpc.getTransaction(txHash)]);
    } catch { throw new NativeMinterError("RPC_UNAVAILABLE", 503); }
    if (!receiptRaw || typeof receiptRaw !== "object" || !txRaw || typeof txRaw !== "object") return { ...status, status: "SUBMITTED", blockNumber: null, blockHash: null };
    const receipt = receiptRaw as Record<string, any>, tx = txRaw as Record<string, any>;
    const hash = txHash.toLowerCase();
    const parseHex = (value: unknown) => typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : null;
    const txValue = parseHex(tx.value), txChain = parseHex(tx.chainId);
    if (String(receipt.transactionHash).toLowerCase() !== hash || String(tx.hash).toLowerCase() !== hash
      || String(tx.from).toLowerCase() !== readiness.signerAddress.toLowerCase()
      || String(tx.to).toLowerCase() !== NATIVE_MINTER_ADDRESS.toLowerCase()
      || String(tx.input ?? tx.data).toLowerCase() !== nativeMinterAbi.encodeFunctionData("mintNativeCoin", [expected.recipient, expected.amountWei]).toLowerCase()
      || txValue !== 0n || txChain !== BigInt(CLOUD_CAMPUS_CHAIN_ID)
      || !/^0x[0-9a-f]{64}$/i.test(String(receipt.blockHash))
      || status.blockNumber === null || status.blockNumber !== Number(parseHex(receipt.blockNumber))
      || status.blockHash?.toLowerCase() !== String(receipt.blockHash).toLowerCase()) throw new NativeMinterError("MINT_RECEIPT_MISMATCH", 409);
    let blockRaw: unknown;
    try { blockRaw = await rpc.getBlock(String(receipt.blockNumber)); }
    catch { throw new NativeMinterError("RPC_UNAVAILABLE", 503); }
    if (!blockRaw || typeof blockRaw !== "object" || String((blockRaw as Record<string, unknown>).hash).toLowerCase() !== String(receipt.blockHash).toLowerCase()) {
      throw new NativeMinterError("MINT_RECEIPT_MISMATCH", 409);
    }
    if (status.status === "CONFIRMED") {
      const found = Array.isArray(receipt.logs) && receipt.logs.some((raw: Record<string, unknown>) => {
        if (String(raw.transactionHash).toLowerCase() !== hash || raw.removed
          || String(raw.blockHash).toLowerCase() !== String(receipt.blockHash).toLowerCase()
          || String(raw.blockNumber).toLowerCase() !== String(receipt.blockNumber).toLowerCase()) return false;
        const event = NativeMinterService.decodeMintEvent(raw);
        return event?.sender.toLowerCase() === readiness.signerAddress!.toLowerCase()
          && event.recipient.toLowerCase() === getAddress(expected.recipient).toLowerCase()
          && event.amountWei === expected.amountWei;
      });
      if (!found) throw new NativeMinterError("MINT_RECEIPT_MISMATCH", 409);
    }
    return status;
  }

  static decodeMintEvent(log: { address?: unknown; topics?: unknown; data?: unknown }) {
    if (typeof log.address !== "string" || log.address.toLowerCase() !== NATIVE_MINTER_ADDRESS.toLowerCase()
      || !Array.isArray(log.topics) || typeof log.data !== "string") return null;
    try {
      const event = nativeMinterAbi.parseLog({ topics: log.topics as string[], data: log.data });
      if (event?.name !== "NativeCoinMinted") return null;
      return { sender: getAddress(String(event.args.sender)), recipient: getAddress(String(event.args.recipient)), amountWei: BigInt(event.args.amount) };
    } catch {
      return null;
    }
  }
}
