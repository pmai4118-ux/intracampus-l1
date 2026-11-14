import { randomBytes } from "node:crypto";
import { Interface, type InterfaceAbi } from "ethers";
import {
  campusNetwork, requireLibraryDeployment, type DeployedLibraryDeployment, type LibraryAccount,
  type LibraryApiErrorCode, type LibraryBook, type LibraryDepositIntent, type LibraryLoan,
  type LibraryRequest, type LibrarySettlement, type LibrarySettlementIntent, type LibrarySettlementIntentRequest,
  type LibraryTransaction, type LibraryTransactionAction,
} from "@intracampus/network";
import type { LibraryChainFreshness } from "./library.config.ts";
import { LibraryConfigurationError } from "./library.config.ts";
import type { LibraryBookRecord, LibraryRepository, LibraryRequestRecord } from "./library.repository.ts";
import { LibraryChainError, LibraryReconciler } from "./library.reconcile.ts";
import { HttpLibraryRpc, LibraryRpcError, type LibraryRpcClient } from "./library.rpc.ts";

export class LibraryServiceError extends Error {
  readonly code: LibraryApiErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  constructor(code: LibraryApiErrorCode, httpStatus: number, retryable = false, retryAfterSeconds?: number) {
    super(code);
    this.name = "LibraryServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type LibraryServiceConfig = {
  deployment?: unknown;
  rpcUrl?: string;
  allowLocal?: boolean;
  chainFreshness?: LibraryChainFreshness;
  rpc?: LibraryRpcClient;
  now?: () => number;
};

function serviceFailure(error: unknown): LibraryServiceError {
  if (error instanceof LibraryServiceError) return error;
  if (error instanceof LibraryChainError) {
    if (error.code === "WRONG_CHAIN") return new LibraryServiceError("WRONG_CHAIN", 503, true, 2);
    if (error.code === "STALE_CHAIN_STATE") return new LibraryServiceError("STALE_CHAIN_STATE", 503, true, 2);
    if (error.code === "CONFIGURATION_ERROR") return new LibraryServiceError("CONFIGURATION_ERROR", 503);
    return new LibraryServiceError("RPC_UNAVAILABLE", 503, true, 2);
  }
  if (error instanceof LibraryRpcError) return new LibraryServiceError(error.code, 503, true, 2);
  if (error instanceof LibraryConfigurationError) return new LibraryServiceError("CONFIGURATION_ERROR", 503);
  const message = error instanceof Error ? error.message : "";
  if (message === "LIBRARY_DATABASE_BUSY") return new LibraryServiceError("DATABASE_BUSY", 503, true, 1);
  if (message === "LIBRARY_REORG_DETECTED" || message === "LIBRARY_RECONCILE_STATE_MISSING") {
    return new LibraryServiceError("STALE_CHAIN_STATE", 503, true, 2);
  }
  if (["LIBRARY_REQUEST_NOT_FOUND", "LIBRARY_BOOK_NOT_FOUND", "LIBRARY_ACCOUNT_NOT_ALLOWED"].includes(message)) {
    return new LibraryServiceError(message === "LIBRARY_ACCOUNT_NOT_ALLOWED" ? "FORBIDDEN" : "NOT_FOUND", message === "LIBRARY_ACCOUNT_NOT_ALLOWED" ? 403 : 404);
  }
  if (message === "LIBRARY_ACCOUNT_HELD") return new LibraryServiceError("FORBIDDEN", 403);
  if (message.includes("CONFLICT") || message === "LIBRARY_NO_AVAILABLE_COPY" || message === "LIBRARY_INVALID_LOAN_STATE") {
    return new LibraryServiceError("CONFLICT", 409);
  }
  if (message.startsWith("INVALID_LIBRARY_") || message === "INVALID_LIBRARY_VERIFIED_EVENT") {
    return new LibraryServiceError("VALIDATION_ERROR", 400);
  }
  return new LibraryServiceError("INTERNAL_ERROR", 500);
}

export function toLibraryServiceError(error: unknown): LibraryServiceError { return serviceFailure(error); }

export class LibraryService {
  private readonly repository: LibraryRepository;
  private readonly config: LibraryServiceConfig;
  private rpc?: LibraryRpcClient;
  private ownsRpc = false;
  private deployment?: DeployedLibraryDeployment;
  private reconciler?: LibraryReconciler;
  private readonly now: () => number;

  constructor(repository: LibraryRepository, config: LibraryServiceConfig = {}) {
    this.repository = repository;
    this.config = config;
    this.rpc = config.rpc;
    this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
  }

  close(): void {
    if (this.ownsRpc) this.rpc?.destroy?.();
    this.rpc = undefined;
  }

  async listBooks(_wallet: string, query = ""): Promise<LibraryBook[]> {
    const chain = await this.reconciled();
    const catalog = this.repository.listBooks();
    await this.assertLiveTermsMatchDeployment(chain.safeBlock, catalog);
    const books = this.repository.listBooks(query);
    return books.map((book) => ({ ...book, bookId: book.bookId as `0x${string}` }));
  }

  async createRequest(input: { account: LibraryAccount; bookId: string; idempotencyKey: string }): Promise<{
    request: LibraryRequest; depositIntent: LibraryDepositIntent | null;
  }> {
    const chain = await this.reconciled();
    const bookId = input.bookId.toLowerCase();
    const book = this.repository.listBooks().find((item) => item.bookId === bookId);
    if (!book) throw new LibraryServiceError("NOT_FOUND", 404);
    await this.assertLiveTermsMatchDeployment(chain.safeBlock, this.repository.listBooks());
    let request: LibraryRequestRecord;
    try {
      request = this.repository.createDepositRequest({ requestId: `0x${randomBytes(32).toString("hex")}`,
        wallet: input.account.wallet, bookId, idempotencyKey: input.idempotencyKey, createdAt: chain.chainTime,
        chainTime: chain.chainTime, holdAfterSeconds: this.deploymentOrThrow().policy.fullDepositRetentionAfterSeconds });
    } catch (error) { throw serviceFailure(error); }
    const depositIntent = request.status === "AWAITING_DEPOSIT" ? this.depositIntent(request, book) : null;
    return { request: this.publicRequest(request, depositIntent), depositIntent };
  }

  async listRequests(account: LibraryAccount, queue = false): Promise<LibraryRequest[]> {
    await this.reconciled();
    if (queue && account.role !== "LIBRARIAN") throw new LibraryServiceError("FORBIDDEN", 403);
    const records = this.repository.listRequests(account.wallet, queue);
    return records.map((record) => this.publicRequest(record, record.status === "AWAITING_DEPOSIT"
      ? this.depositIntent(record, this.findBook(record.bookId)) : null));
  }

  async getRequest(account: LibraryAccount, requestId: string): Promise<LibraryRequest> {
    await this.reconciled();
    let record: LibraryRequestRecord | undefined;
    try { record = this.repository.getRequest(requestId); }
    catch (error) { throw serviceFailure(error); }
    if (!record || (account.role !== "LIBRARIAN" && record.wallet.toLowerCase() !== account.wallet.toLowerCase())) {
      throw new LibraryServiceError("NOT_FOUND", 404);
    }
    const intent = record.status === "AWAITING_DEPOSIT" ? this.depositIntent(record, this.findBook(record.bookId)) : null;
    return this.publicRequest(record, intent);
  }

  async listLoans(account: LibraryAccount, borrowerWallet?: string): Promise<LibraryLoan[]> {
    await this.reconciled();
    const target = account.role === "LIBRARIAN" ? borrowerWallet : account.wallet;
    if (borrowerWallet && account.role !== "LIBRARIAN") throw new LibraryServiceError("FORBIDDEN", 403);
    try {
      return this.repository.listLoans(target).map((loan) => ({ ...loan,
        loanId: loan.loanId as `0x${string}`, requestId: loan.requestId as `0x${string}`, bookId: loan.bookId as `0x${string}`,
        borrower: loan.borrower as `0x${string}`, status: loan.status as LibraryLoan["status"],
        settlement: loan.settlement as LibraryLoan["settlement"] }));
    } catch (error) { throw serviceFailure(error); }
  }

  async requestReturn(account: LibraryAccount, loanId: string): Promise<{ loanId: string; requestId: string; status: string; requestedAt: number }> {
    const chain = await this.reconciled();
    if (account.role !== "STUDENT") throw new LibraryServiceError("FORBIDDEN", 403);
    try { return this.repository.requestReturn({ loanId, wallet: account.wallet, requestedAt: chain.chainTime }); }
    catch (error) { throw serviceFailure(error); }
  }

  async accountStatus(account: LibraryAccount): Promise<{ held: boolean; checkedAt: number; blockingLoanIds: `0x${string}`[] }> {
    const chain = await this.reconciled();
    try {
      const status = this.repository.accountStatus(account.wallet, chain.chainTime, this.deploymentOrThrow().policy.fullDepositRetentionAfterSeconds);
      return { ...status, blockingLoanIds: status.blockingLoanIds as `0x${string}`[] };
    } catch (error) { throw serviceFailure(error); }
  }

  async createSettlementIntent(account: LibraryAccount, loanId: string, input: LibrarySettlementIntentRequest): Promise<LibrarySettlementIntent> {
    const chain = await this.reconciled();
    if (account.role !== "LIBRARIAN") throw new LibraryServiceError("FORBIDDEN", 403);
    const deployment = this.deploymentOrThrow();
    if (account.wallet.toLowerCase() !== deployment.roles.librarian.toLowerCase()) throw new LibraryServiceError("FORBIDDEN", 403);
    let loan: ReturnType<LibraryRepository["loanForSettlement"]>;
    try { loan = this.repository.loanForSettlement(loanId); }
    catch (error) { throw serviceFailure(error); }
    if (!loan) throw new LibraryServiceError("NOT_FOUND", 404);
    const iface = new Interface(deployment.escrow.abi as InterfaceAbi);
    const intentId = randomBytes(32).toString("hex");
    let outcome: LibrarySettlement;
    let data: `0x${string}`;
    try {
      if (input.outcome === "RETURNED") {
        if (loan.returnReceivedAt === null) throw new Error("LIBRARY_INVALID_LOAN_STATE");
        if (!/^(0|[1-9][0-9]*)$/.test(input.repairRequestedWei) || BigInt(input.repairRequestedWei) >= 2n ** 256n) {
          throw new Error("INVALID_LIBRARY_WEI");
        }
        const repair = BigInt(input.repairRequestedWei);
        if ((input.condition === "DAMAGED") !== (repair > 0n)) throw new Error("INVALID_LIBRARY_SETTLEMENT_INTENT");
        const policy = deployment.policy;
        const elapsed = Math.max(0, loan.returnReceivedAt - loan.dueAt);
        const accruedIntervals = elapsed <= policy.gracePeriodSeconds
          ? 0n : BigInt(Math.floor((elapsed - policy.gracePeriodSeconds) / policy.lateFeeIntervalSeconds));
        const deposit = BigInt(loan.depositWei);
        const lateFee = [accruedIntervals * BigInt(policy.lateFeePerIntervalWei), BigInt(policy.maxLateFeeWei), deposit]
          .reduce((smallest, current) => current < smallest ? current : smallest);
        const returnedLate = elapsed > policy.fullDepositRetentionAfterSeconds;
        const repairFee = returnedLate ? 0n : (repair < deposit - lateFee ? repair : deposit - lateFee);
        const overdueForfeit = returnedLate ? deposit - lateFee : 0n;
        const retained = returnedLate ? deposit : lateFee + repairFee;
        const refund = returnedLate ? 0n : deposit - retained;
        outcome = { outcome: "RETURNED", returnedAt: loan.returnReceivedAt, lateFeeWei: lateFee.toString(),
          repairFeeWei: repairFee.toString(), overdueForfeitWei: overdueForfeit.toString(), totalRetainedWei: retained.toString(),
          refundWei: refund.toString(), maintenanceRequired: repair > 0n };
        data = iface.encodeFunctionData("settleReturn", [loan.requestId, input.repairRequestedWei]) as `0x${string}`;
        this.repository.createSettlementIntent({ intentId, loanId: loan.loanId, librarianWallet: account.wallet,
          outcome: "RETURNED", condition: input.condition, reason: input.reason, repairRequestedWei: input.repairRequestedWei,
          createdAt: chain.chainTime });
      } else {
        const deposit = BigInt(loan.depositWei), replacement = BigInt(loan.replacementPriceWei);
        const retained = replacement < deposit ? replacement : deposit;
        const refund = deposit - retained;
        const shortfall = replacement > deposit ? replacement - deposit : 0n;
        outcome = { outcome: "LOST", replacementPriceWei: replacement.toString(), totalRetainedWei: retained.toString(),
          refundWei: refund.toString(), shortfallWei: shortfall.toString() };
        data = iface.encodeFunctionData("settleLost", [loan.requestId]) as `0x${string}`;
        this.repository.createSettlementIntent({ intentId, loanId: loan.loanId, librarianWallet: account.wallet,
          outcome: "LOST", reason: input.reason, createdAt: chain.chainTime });
      }
    } catch (error) { throw serviceFailure(error); }
    return { intentId, requestId: loan.requestId as `0x${string}`, loanId: loan.loanId as `0x${string}`,
      borrower: loan.borrower as `0x${string}`, chainId: 20261, escrow: deployment.escrow.address as `0x${string}`,
      treasury: deployment.treasury as `0x${string}`, walletCall: { to: deployment.escrow.address as `0x${string}`,
        data, valueWei: "0" }, preview: outcome, outcome: input.outcome, chainTime: chain.chainTime } as LibrarySettlementIntent;
  }

  async submitTransaction(account: LibraryAccount, requestId: string, input: {
    action: LibraryTransactionAction; txHash: string; settlementIntentId?: string;
  }): Promise<{ request: LibraryRequest; transaction: LibraryTransaction | null }> {
    const chain = await this.reconciled();
    let record: LibraryRequestRecord | undefined;
    try { record = this.repository.getRequest(requestId); }
    catch (error) { throw serviceFailure(error); }
    if (!record || (account.role !== "LIBRARIAN" && record.wallet.toLowerCase() !== account.wallet.toLowerCase())) {
      throw new LibraryServiceError("NOT_FOUND", 404);
    }
    const action = input.action;
    const settlementAction = action === "return" || action === "settle";
    const librarianAction = ["approve", "reject", "confirmReturn", "return", "settle"].includes(action);
    if (librarianAction !== (account.role === "LIBRARIAN")) throw new LibraryServiceError("FORBIDDEN", 403);
    const deployment = this.deploymentOrThrow();
    if (librarianAction && account.wallet.toLowerCase() !== deployment.roles.librarian.toLowerCase()) {
      throw new LibraryServiceError("FORBIDDEN", 403);
    }
    const confirmed = this.repository.getTransaction(record.requestId, action);
    if (confirmed && confirmed.txHash.toLowerCase() !== input.txHash.toLowerCase() && confirmed.status !== "REVERTED") {
      throw new LibraryServiceError("CONFLICT", 409);
    }
    if (confirmed?.status === "CONFIRMED" && !settlementAction) {
      return { request: await this.getRequest(account, record.requestId), transaction: this.publicTransaction(confirmed, record) };
    }
    const expectedFunctions: Record<LibraryTransactionAction, string> = {
      deposit: "deposit", approve: "approve", reject: "reject", refund: "claimExpiredRefund",
      confirmReturn: "confirmPhysicalReturn", return: "settleReturn", settle: "settleLost", payShortfall: "payShortfall",
    };
    if (action === "approve" && (record.status !== "PENDING_APPROVAL" || record.copyId === null
      || record.approvalDeadline === null || chain.chainTime >= record.approvalDeadline)) throw new LibraryServiceError("CONFLICT", 409);
    if (action === "reject" && !((record.status === "PENDING_APPROVAL" && record.copyId !== null)
      || (record.status === "REJECTED_NO_COPY" && record.copyId === null))) throw new LibraryServiceError("CONFLICT", 409);
    if (action === "deposit" && record.status !== "AWAITING_DEPOSIT") throw new LibraryServiceError("CONFLICT", 409);
    if (action === "refund" && (!(["EXPIRED_REFUND_DUE", "REJECTED_NO_COPY"].includes(record.status))
      || record.approvalDeadline === null || chain.chainTime < record.approvalDeadline)) throw new LibraryServiceError("CONFLICT", 409);
    if (action === "confirmReturn" && !["APPROVED", "RETURN_REQUESTED"].includes(record.status)) throw new LibraryServiceError("CONFLICT", 409);
    if (action === "return" || action === "settle") {
      const intent = input.settlementIntentId ? this.repository.getSettlementIntent(input.settlementIntentId) : undefined;
      const expectedOutcome = action === "return" ? "RETURNED" : "LOST";
      if (!intent || intent.requestId !== record.requestId || intent.librarianWallet.toLowerCase() !== account.wallet.toLowerCase()
        || intent.outcome !== expectedOutcome) throw new LibraryServiceError("FORBIDDEN", 403);
    } else if (input.settlementIntentId !== undefined) throw new LibraryServiceError("VALIDATION_ERROR", 400);
    if (action === "payShortfall" && record.status !== "LOST_SHORTFALL_DUE") throw new LibraryServiceError("CONFLICT", 409);

    const rpc = this.rpcClient();
    let tx;
    try { tx = await rpc.getTransaction(input.txHash); }
    catch { throw new LibraryServiceError("RPC_UNAVAILABLE", 503, true, 2); }
    if (!tx) {
      if (confirmed?.status === "CONFIRMED" && settlementAction) {
        throw new LibraryServiceError("RPC_UNAVAILABLE", 503, true, 2);
      }
      const existing = this.repository.getTransaction(record.requestId, action);
      if (existing && existing.txHash.toLowerCase() !== input.txHash.toLowerCase() && existing.status !== "REVERTED") {
        throw new LibraryServiceError("CONFLICT", 409);
      }
      return { request: await this.getRequest(account, record.requestId), transaction: existing ? this.publicTransaction(existing, record) : null };
    }
    const iface = new Interface(deployment.escrow.abi as InterfaceAbi);
    let parsed;
    try { parsed = iface.parseTransaction({ data: tx.data, value: tx.value }); }
    catch { throw new LibraryServiceError("CONFLICT", 409); }
    if (!parsed || parsed.name !== expectedFunctions[action] || tx.to?.toLowerCase() !== deployment.escrow.address.toLowerCase()
      || String(parsed.args[0]).toLowerCase() !== record.requestId.toLowerCase()) throw new LibraryServiceError("CONFLICT", 409);
    const expectedFrom = librarianAction ? deployment.roles.librarian : record.wallet;
    if (tx.from.toLowerCase() !== expectedFrom.toLowerCase()) throw new LibraryServiceError("FORBIDDEN", 403);
    let expectedValue = 0n;
    if (action === "deposit") {
      const book = this.findBook(record.bookId);
      if (String(parsed.args[1]).toLowerCase() !== record.bookId.toLowerCase()) throw new LibraryServiceError("CONFLICT", 409);
      expectedValue = BigInt(book.depositWei);
    } else if (action === "payShortfall") {
      const loan = this.repository.listLoans(record.wallet).find((item) => item.requestId === record.requestId);
      const settlement = loan?.settlement as LibrarySettlement | null | undefined;
      if (!settlement || settlement.outcome !== "LOST") throw new LibraryServiceError("CONFLICT", 409);
      expectedValue = BigInt(settlement.shortfallWei);
    } else if (action === "return") {
      const intent = this.repository.getSettlementIntent(input.settlementIntentId!);
      if (!intent || intent.repairRequestedWei === null || BigInt(parsed.args[1]) !== BigInt(intent.repairRequestedWei)) {
        throw new LibraryServiceError("CONFLICT", 409);
      }
    }
    if (tx.value !== expectedValue) throw new LibraryServiceError("CONFLICT", 409);
    let submitted;
    try { submitted = this.repository.recordTransactionSubmission({ requestId: record.requestId, action, txHash: input.txHash,
      submittedAt: chain.chainTime, ...(settlementAction ? { settlementIntentId: input.settlementIntentId!, librarianWallet: account.wallet } : {}) }); }
    catch (error) { throw serviceFailure(error); }
    let receipt;
    try { receipt = await rpc.getTransactionReceipt(input.txHash); }
    catch { throw new LibraryServiceError("RPC_UNAVAILABLE", 503, true, 2); }
    if (receipt?.status === 0 && receipt.blockNumber <= chain.safeBlock) {
      const block = await rpc.getBlock(receipt.blockNumber);
      if (block?.hash?.toLowerCase() === receipt.blockHash.toLowerCase()) {
        try { submitted = this.repository.markTransactionReverted({ requestId: record.requestId, action, txHash: input.txHash,
          blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, checkedAt: chain.checkedAt }); }
        catch (error) { throw serviceFailure(error); }
      }
    }
    if (receipt?.status === 1) {
      await this.reconciled();
      submitted = this.repository.getTransaction(record.requestId, action) ?? submitted;
    }
    return { request: await this.getRequest(account, record.requestId), transaction: this.publicTransaction(submitted, record) };
  }

  private async reconciled() {
    try {
      const result = await this.reconcilerOrThrow().reconcile();
      if (!result.caughtUp) throw new LibraryChainError("STALE_CHAIN_STATE");
      return result;
    } catch (error) { throw serviceFailure(error); }
  }

  private reconcilerOrThrow(): LibraryReconciler {
    if (this.reconciler) return this.reconciler;
    if (!this.config.chainFreshness) throw new LibraryConfigurationError();
    const deployment = this.deploymentOrThrow();
    const rpc = this.rpcClient();
    this.reconciler = new LibraryReconciler(this.repository, rpc, deployment, this.config.chainFreshness, this.now);
    return this.reconciler;
  }

  private rpcClient(): LibraryRpcClient {
    if (!this.rpc) {
      if (!this.config.rpcUrl?.trim()) throw new LibraryConfigurationError();
      this.rpc = new HttpLibraryRpc(this.config.rpcUrl);
      this.ownsRpc = true;
    }
    return this.rpc;
  }

  private deploymentOrThrow(): DeployedLibraryDeployment {
    if (this.deployment) return this.deployment;
    try {
      const manifest = requireLibraryDeployment(this.config.deployment, { allowLocal: this.config.allowLocal });
      this.deployment = manifest.library;
      return this.deployment;
    } catch (error) {
      if (error instanceof Error && error.message === "WRONG_CHAIN") throw new LibraryServiceError("WRONG_CHAIN", 503, true, 2);
      throw new LibraryConfigurationError();
    }
  }

  private assertSeedMatchesDeployment(books: LibraryBookRecord[]): void {
    const deployed = this.deploymentOrThrow().books;
    if (books.length !== deployed.length || books.some((book) => {
      const terms = deployed.find((item) => item.bookId.toLowerCase() === book.bookId.toLowerCase());
      return !terms || terms.depositWei !== book.depositWei || terms.replacementPriceWei !== book.replacementPriceWei;
    })) throw new LibraryServiceError("CONFIGURATION_ERROR", 503);
  }

  private async assertLiveTermsMatchDeployment(safeBlock: number, books: LibraryBookRecord[]): Promise<void> {
    this.assertSeedMatchesDeployment(books);
    const deployment = this.deploymentOrThrow();
    const iface = new Interface(deployment.escrow.abi as InterfaceAbi);
    const rpc = this.rpcClient();
    for (const expected of deployment.books) {
      let raw: string;
      try {
        raw = await rpc.call({ to: deployment.escrow.address,
          data: iface.encodeFunctionData("bookTerms", [expected.bookId]) }, safeBlock);
      } catch (error) {
        if (error instanceof LibraryRpcError) throw new LibraryServiceError(error.code, 503, true, 2);
        throw new LibraryServiceError("RPC_UNAVAILABLE", 503, true, 2);
      }
      try {
        const [depositWei, replacementPriceWei, isSealed] = iface.decodeFunctionResult("bookTerms", raw);
        if (!isSealed || depositWei.toString() !== expected.depositWei
          || replacementPriceWei.toString() !== expected.replacementPriceWei) throw new LibraryServiceError("CONFIGURATION_ERROR", 503);
      } catch (error) {
        if (error instanceof LibraryServiceError) throw error;
        throw new LibraryServiceError("CONFIGURATION_ERROR", 503);
      }
    }
  }

  private findBook(bookId: string): LibraryBookRecord {
    const book = this.repository.listBooks().find((item) => item.bookId === bookId);
    if (!book) throw new LibraryServiceError("NOT_FOUND", 404);
    this.assertSeedMatchesDeployment(this.repository.listBooks());
    return book;
  }

  private depositIntent(request: LibraryRequestRecord, book: LibraryBookRecord): LibraryDepositIntent {
    const deployment = this.deploymentOrThrow();
    const iface = new Interface(deployment.escrow.abi as InterfaceAbi);
    return { chainId: campusNetwork.chainId, to: deployment.escrow.address as `0x${string}`,
      data: iface.encodeFunctionData("deposit", [request.requestId, request.bookId]) as `0x${string}`,
      valueWei: book.depositWei, requestId: request.requestId as `0x${string}`, bookId: request.bookId as `0x${string}` };
  }

  private publicRequest(record: LibraryRequestRecord, depositIntent: LibraryDepositIntent | null): LibraryRequest {
    const deployment = this.deploymentOrThrow();
    const transactions: LibraryTransaction[] = this.repository.listTransactions(record.requestId).map((item) => ({
      action: item.action,
      txHash: item.txHash as `0x${string}`,
      status: item.status,
      submittedAt: item.submittedAt,
      proof: item.status === "CONFIRMED" && item.eventName ? {
        chainId: 20261, contractAddress: deployment.escrow.address as `0x${string}`,
        txHash: item.txHash as `0x${string}`, blockNumber: item.blockNumber!, blockHash: item.blockHash as `0x${string}`,
        logIndex: item.logIndex!, eventName: item.eventName as NonNullable<LibraryTransaction["proof"]>["eventName"],
        requestId: record.requestId as `0x${string}`, borrower: record.wallet as `0x${string}`,
      } : null,
    }));
    const loanId = this.repository.listLoans(record.wallet).find((loan) => loan.requestId === record.requestId)?.loanId ?? null;
    return { requestId: record.requestId as `0x${string}`, bookId: record.bookId as `0x${string}`,
      status: record.status as LibraryRequest["status"], refundStatus: record.refundStatus,
      depositWei: record.depositWei, depositIntent, approvalDeadline: record.approvalDeadline,
      loanId: loanId as `0x${string}` | null, transactions, createdAt: record.createdAt, updatedAt: record.updatedAt };
  }

  private publicTransaction(item: NonNullable<ReturnType<LibraryRepository["getTransaction"]>>, record: LibraryRequestRecord): LibraryTransaction {
    const deployment = this.deploymentOrThrow();
    return { action: item.action, txHash: item.txHash as `0x${string}`, status: item.status, submittedAt: item.submittedAt,
      proof: item.status === "CONFIRMED" && item.eventName ? { chainId: 20261,
        contractAddress: deployment.escrow.address as `0x${string}`, txHash: item.txHash as `0x${string}`,
        blockNumber: item.blockNumber!, blockHash: item.blockHash as `0x${string}`, logIndex: item.logIndex!,
        eventName: item.eventName as NonNullable<LibraryTransaction["proof"]>["eventName"],
        requestId: record.requestId as `0x${string}`, borrower: record.wallet as `0x${string}` } : null };
  }
}
