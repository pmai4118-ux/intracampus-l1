import { campusNetwork, type InvoiceApiError, type InvoiceLookupResponse, type VerifiedInvoiceReceipt } from "@intracampus/network";
import type { InvoiceRecord, InvoiceRepository } from "./invoices.repository.ts";
import { InvoiceRpcError, type InvoiceRpc } from "./invoices.rpc.ts";
import { hex, isAddress, isHash, object, quantity, safeInteger, safeQuantity, same } from "./invoices.schema.ts";
import { invoicePaidTopic, paymentAbi, readReceipt, verifyReceiptLog } from "./receipt.verifier.ts";

export type InvoiceDeployment = { contractAddress: string; deploymentBlock: number };
export type LookupResult = { httpStatus: 200 | 422 | 503; body: InvoiceLookupResponse; retryAfterSeconds?: number };
type Block = { number: number; timestamp: number; hash: string };
type Backoff = { failures: number; until: number; code: "RPC_UNAVAILABLE" | "WRONG_CHAIN" };

export function invoiceError(code: InvoiceApiError["code"]): InvoiceApiError {
  const messages: Record<InvoiceApiError["code"], [string, string]> = {
    INVALID_REQUEST: ["Dữ liệu yêu cầu không hợp lệ hoặc bị thiếu.", "Kiểm tra lại mã hóa đơn và mã giao dịch."],
    INVOICE_NOT_FOUND: ["Không tìm thấy hóa đơn cần tra cứu.", "Kiểm tra lại mã hóa đơn hoặc tạo hóa đơn mới trên POS."],
    RPC_UNAVAILABLE: ["Chưa đủ dữ liệu RPC để xác minh thanh toán.", "Giữ hash giao dịch cũ và thử tra cứu lại; không gửi lại thanh toán."],
    WRONG_CHAIN: ["Đang kết nối sai mạng (yêu cầu IntraCampus L1 — Chain ID 20261).", "Cấu hình RPC về IntraCampus L1 (20261) rồi thử lại."],
    TX_REVERTED: ["Giao dịch trên chuỗi bị từ chối (revert), chưa thanh toán.", "Đối chiếu mã giao dịch và hóa đơn; không tự gửi lại."],
    RECEIPT_EVENT_MISMATCH: ["Giao dịch đã thực thi nhưng không chứa biên nhận thanh toán hợp lệ cho hóa đơn này.", "Giữ trạng thái hiện tại và kiểm tra đúng mã giao dịch thanh toán."],
    INTERNAL_ERROR: ["Không thể lưu hoặc đọc dữ liệu hóa đơn.", "Giữ hash giao dịch và liên hệ người vận hành; không tự gửi lại thanh toán."],
  };
  const [message, nextStep] = messages[code];
  return { code, message, nextStep, retryable: code === "RPC_UNAVAILABLE" || code === "WRONG_CHAIN" };
}

export class InvoiceRequestError extends Error {
  readonly httpStatus: number;
  readonly code: "INVALID_REQUEST" | "INVOICE_NOT_FOUND";
  constructor(code: "INVALID_REQUEST" | "INVOICE_NOT_FOUND") {
    super(code); this.code = code; this.httpStatus = code === "INVALID_REQUEST" ? 400 : 404;
  }
}

export class ReceiptService {
  private repository: InvoiceRepository;
  private rpc: InvoiceRpc;
  private deployment?: InvoiceDeployment;
  private now: () => number;
  private log: (entry: Record<string, unknown>) => void;
  private blockRange: number;
  private maxScanRanges: number;
  private backoffs = new Map<string, Backoff>();
  private pending = new Map<string, Promise<LookupResult>>();

  constructor(options: {
    repository: InvoiceRepository; rpc: InvoiceRpc; deployment?: InvoiceDeployment;
    now?: () => number; log?: (entry: Record<string, unknown>) => void;
    blockRange?: number; maxScanRanges?: number;
  }) {
    this.repository = options.repository; this.rpc = options.rpc; this.deployment = options.deployment;
    this.now = options.now ?? Date.now; this.log = options.log ?? (() => {});
    this.blockRange = options.blockRange ?? 1000; this.maxScanRanges = options.maxScanRanges ?? 10;
    if (!Number.isSafeInteger(this.blockRange) || this.blockRange < 2 || !Number.isSafeInteger(this.maxScanRanges) || this.maxScanRanges < 1) {
      throw new Error("Invalid scan limits");
    }
    if (this.deployment && (!isAddress(this.deployment.contractAddress) || !safeInteger(this.deployment.deploymentBlock))) {
      throw new Error("Invalid invoice deployment");
    }
  }

  async lookup(invoiceId: string, txHash?: string): Promise<LookupResult> {
    if (!isHash(invoiceId) || (txHash !== undefined && !isHash(txHash))) throw new InvoiceRequestError("INVALID_REQUEST");
    const key = invoiceId.toLowerCase();
    // Serialize lookups of the same invoice; persist each hint before consulting RPC.
    const previous = this.pending.get(key);
    if (previous) await previous.catch(() => {});
    // A different waiter may have acquired the slot while this one awaited.
    if (this.pending.has(key)) return this.lookup(invoiceId, txHash);
    const promise = this.lookupOne(key, txHash);
    this.pending.set(key, promise);
    try {
      const result = await promise;
      this.log({ event: "invoice_poll", invoiceId: key, httpStatus: result.httpStatus, status: result.body.status,
        errorCode: "error" in result.body ? result.body.error?.code : undefined, retryAfterSeconds: result.retryAfterSeconds });
      return result;
    } finally { if (this.pending.get(key) === promise) this.pending.delete(key); }
  }

  private async lookupOne(id: string, hint?: string): Promise<LookupResult> {
    let record = this.repository.get(id);
    if (!record) throw new InvoiceRequestError("INVOICE_NOT_FOUND");
    if (record.receipt) return this.paid(record);
    // An unresolved hash survives a different query hint and RPC failures.
    if (hint && (!record.transaction || record.transaction.status !== "unverified")) {
      record = this.repository.save(id, { ...record, transaction: { txHash: hint.toLowerCase(), status: "unverified" } });
      if (record.receipt) return this.paid(record);
    }
    const backoff = this.backoffs.get(id);
    if (backoff && backoff.until > this.now()) return this.unavailable(record, backoff);
    try {
      const result = await this.lookupChain(id, record);
      this.backoffs.delete(id);
      return result;
    } catch (error) {
      if (!(error instanceof InvoiceRpcError)) throw error;
      const latest = this.repository.get(id)!;
      if (latest.receipt) return this.paid(latest);
      const failures = (backoff?.failures ?? 0) + 1;
      const state: Backoff = { failures, until: this.now() + Math.min(30_000, 2000 * 2 ** Math.min(failures - 1, 4)), code: error.code };
      this.backoffs.set(id, state);
      return this.unavailable(latest, state);
    }
  }

  private async lookupChain(id: string, initial: InvoiceRecord): Promise<LookupResult> {
    let record = initial;
    const deployment = this.deployment;
    if (!deployment || !same(record.envelope.domain.verifyingContract, deployment.contractAddress)) throw new InvoiceRpcError();
    const rawChain = await this.call("eth_chainId", []);
    if (this.parse(() => quantity(rawChain)) !== BigInt(campusNetwork.chainId)) throw new InvoiceRpcError("WRONG_CHAIN");
    const head = await this.block("latest");
    if (head.number < deployment.deploymentBlock || (record.nextScanBlock !== null && record.nextScanBlock > head.number + 1)) throw new InvoiceRpcError();
    // Revisit the previous head, and checkpoint only fully scanned ranges. No indexer is required.
    let from = Math.max(deployment.deploymentBlock, (record.nextScanBlock ?? deployment.deploymentBlock) - 1);
    for (let ranges = 0; from <= head.number; ranges++) {
      if (ranges >= this.maxScanRanges) throw new InvoiceRpcError();
      const to = Math.min(head.number, from + this.blockRange - 1);
      const logs = await this.call("eth_getLogs", [{ address: deployment.contractAddress,
        topics: [invoicePaidTopic, id], fromBlock: hex(from), toBlock: hex(to) }]);
      if (!Array.isArray(logs) || logs.length > 10_000) throw new InvoiceRpcError();
      for (const value of logs) {
        const log = this.parse(() => object(value));
        if (!same(log.address, deployment.contractAddress) || !Array.isArray(log.topics)
          || !same(log.topics[0], invoicePaidTopic) || !same(log.topics[1], id)) continue;
        if (!isHash(log.transactionHash)) throw new InvoiceRpcError();
        const outcome = await this.transaction(record, log.transactionHash, head);
        if (!outcome.receipt) throw new InvoiceRpcError();
        return this.confirm(id, record, outcome.receipt);
      }
      record = this.repository.save(id, { ...record, nextScanBlock: to + 1 });
      if (record.receipt) return this.paid(record);
      from = to + 1;
    }
    const paidFlag = await this.call("eth_call", [{ to: deployment.contractAddress,
      data: paymentAbi.encodeFunctionData("isInvoicePaid", [id]) }, hex(head.number)]);
    if (typeof paidFlag !== "string" || !/^0x0{63}[01]$/.test(paidFlag)) throw new InvoiceRpcError();

    let error: InvoiceApiError | undefined;
    if (record.transaction) {
      const outcome = await this.transaction(record, record.transaction.txHash, head);
      if (outcome.receipt) return this.confirm(id, record, outcome.receipt);
      record.transaction = { txHash: record.transaction.txHash, status: outcome.status };
      if (outcome.status === "reverted") error = invoiceError("TX_REVERTED");
      if (outcome.status === "event-mismatch") error = invoiceError("RECEIPT_EVENT_MISMATCH");
    }
    if (paidFlag.endsWith("1")) {
      // A lagging/incomplete log response must not strand an older payment behind the cursor.
      this.repository.save(id, { ...record, nextScanBlock: deployment.deploymentBlock });
      throw new InvoiceRpcError();
    }
    record = this.repository.save(id, { ...record,
      lastKnownStatus: head.timestamp <= record.envelope.invoice.expiresAt ? "pending" : "expired", updatedAt: this.seconds() });
    if (record.receipt) return this.paid(record);
    return { httpStatus: error ? 422 : 200, body: { invoiceId: record.envelope.invoice.invoiceId, envelope: record.envelope,
      status: record.lastKnownStatus!, receipt: null, transaction: record.transaction, updatedAt: record.updatedAt!, ...(error ? { error } : {}) } };
  }

  private async transaction(record: InvoiceRecord, hash: string, head: Block): Promise<{
    receipt: VerifiedInvoiceReceipt | null; status: "unverified" | "reverted" | "event-mismatch";
  }> {
    const raw = await this.call("eth_getTransactionReceipt", [hash]);
    if (raw === null) return { receipt: null, status: "unverified" };
    const r = this.parse(() => readReceipt(raw, hash));
    const blockNumber = this.parse(() => safeQuantity(r.blockNumber));
    if (blockNumber > head.number) throw new InvoiceRpcError();
    const block = await this.block(hex(blockNumber));
    if (block.number !== blockNumber || !same(block.hash, r.blockHash as string)) throw new InvoiceRpcError();
    if (r.status === "0x0") return { receipt: null, status: "reverted" };
    if (block.timestamp <= record.envelope.invoice.expiresAt) {
      for (const log of r.logs as unknown[]) {
        const receipt = verifyReceiptLog(record.envelope, r, log, this.seconds());
        if (receipt) return { receipt, status: "unverified" };
      }
    }
    return { receipt: null, status: "event-mismatch" };
  }

  private confirm(id: string, record: InvoiceRecord, receipt: VerifiedInvoiceReceipt): LookupResult {
    const result = this.repository.confirm(id, { ...record, receipt, updatedAt: receipt.verifiedAt,
      transaction: { txHash: receipt.txHash, status: "confirmed" } });
    if (result.changed) this.log({ event: "invoice_paid", invoiceId: id, chainId: receipt.chainId,
      contractAddress: receipt.contractAddress, txHash: receipt.txHash, logIndex: receipt.logIndex });
    return this.paid(result.record);
  }
  private paid(record: InvoiceRecord): LookupResult {
    const receipt = record.receipt!;
    return { httpStatus: 200, body: { invoiceId: record.envelope.invoice.invoiceId, envelope: record.envelope,
      status: "paid", receipt, transaction: { txHash: receipt.txHash, status: "confirmed" }, updatedAt: receipt.verifiedAt } };
  }
  private unavailable(record: InvoiceRecord, backoff: Backoff): LookupResult {
    return { httpStatus: 503, retryAfterSeconds: Math.max(1, Math.ceil((backoff.until - this.now()) / 1000)), body: {
      invoiceId: record.envelope.invoice.invoiceId, envelope: record.envelope, status: "rpc-error",
      lastKnownStatus: record.lastKnownStatus, receipt: null, transaction: record.transaction, updatedAt: record.updatedAt,
      error: invoiceError(backoff.code),
    } };
  }
  private seconds(): number { return Math.floor(this.now() / 1000); }
  private parse<T>(fn: () => T): T { try { return fn(); } catch { throw new InvoiceRpcError(); } }
  private async call(method: string, params: unknown[]): Promise<unknown> {
    try { return await this.rpc.call(method, params); } catch { throw new InvoiceRpcError(); }
  }
  private async block(tag: string): Promise<Block> {
    const raw = await this.call("eth_getBlockByNumber", [tag, false]);
    return this.parse(() => {
      const b = object(raw);
      if (!isHash(b.hash)) throw new Error("Invalid block hash");
      return { number: safeQuantity(b.number), timestamp: safeQuantity(b.timestamp), hash: b.hash };
    });
  }
}
