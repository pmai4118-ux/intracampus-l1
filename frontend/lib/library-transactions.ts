import { Interface, type InterfaceAbi } from 'ethers';
import type { DeployedLibraryDeployment, LibraryRequest, LibrarySettlementIntent } from '@intracampus/network';
import type { WalletSnapshot, WalletTransaction } from './wallet.ts';
import { WalletTransactionError } from './wallet.ts';
import { requireLibraryStudentNotHeld } from './library-session.ts';
import { LibraryApi, LibraryUiError, bytes32, check } from './library-api.ts';

export type StudentAction = 'deposit' | 'refund' | 'payShortfall';
export type StaffAction = 'approve' | 'reject' | 'confirmReturn' | 'return' | 'settle';
export type LibraryAction = StudentAction | StaffAction;
export type LibraryCall = { requestId: string; action: LibraryAction; transaction: WalletTransaction; amountWei: string; recipient: string; refundWei: string; previousHash: string | null; settlementIntentId?: string; intent?: LibrarySettlementIntent; repairRequestedWei?: string };
export type LibraryJournal = { version: 1; attemptId: string; requestId: string; action: LibraryAction; account: string; deployment: string;
  phase: 'unknown' | 'pending' | 'confirmed' | 'reverted'; hash: string | null; previousHash: string | null; settlementIntentId?: string };
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Partial<Pick<Storage, 'key' | 'length'>>;
type Sender = { getSnapshot(): Pick<WalletSnapshot, 'address' | 'chainId' | 'canProceed'> & Partial<Pick<WalletSnapshot, 'blockTimestamp'>>; refresh?: () => Promise<void>;
  sendTransactionWithGuard(account: string, transaction: WalletTransaction, guard: () => void): Promise<string> };
type Options = { deployment: DeployedLibraryDeployment; account: string; api: LibraryApi; wallet: Sender; storage: Store; role?: 'STUDENT' | 'LIBRARIAN';
  lock: (key: string, run: () => Promise<void>) => Promise<void> };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function verifiedBorrower(request: LibraryRequest, id: string, escrow: string): string {
  const deposit = request.transactions.find(tx => tx.action === 'deposit' && tx.status === 'CONFIRMED' && tx.proof?.eventName === 'DepositReceived');
  const proof = deposit?.proof;
  if (!proof || proof.chainId !== 20261 || !same(proof.contractAddress, escrow) || !same(proof.requestId, id) || !same(proof.txHash, deposit.txHash)) throw new LibraryUiError('INTENT_MISMATCH');
  return proof.borrower;
}
export class LibraryTransactions {
  readonly options: Options;
  readonly deploymentKey: string;
  private readonly transient = new Map<string, LibraryJournal>();
  constructor(options: Options) {
    this.options = options;
    this.deploymentKey = `20261:${options.deployment.escrow.address.toLowerCase()}:${options.deployment.escrow.transactionHash.toLowerCase()}`;
  }
  key(id: string, action: LibraryAction) { return `intracampus.library.v1:${this.deploymentKey}:${this.options.account.toLowerCase()}:${id}:${action}`; }
  journal(id: string, action: LibraryAction): LibraryJournal | null {
    try {
      const raw = this.options.storage.getItem(this.key(id, action)); if (raw === null) return this.transient.get(this.key(id, action)) ?? null;
      const v = JSON.parse(raw);
      check(v.version === 1 && typeof v.attemptId === 'string' && v.attemptId.length > 0 && v.requestId === id && v.action === action && same(v.account, this.options.account)
        && v.deployment === this.deploymentKey && ['unknown','pending','confirmed','reverted'].includes(v.phase)
        && (v.hash === null || bytes32(v.hash)) && (v.previousHash === null || bytes32(v.previousHash))
        && (!['return','settle'].includes(action) || (typeof v.settlementIntentId === 'string' && /^[0-9a-f]{64}$/i.test(v.settlementIntentId))));
      const known = this.transient.get(this.key(id, action));
      if (known && known.attemptId !== v.attemptId) this.transient.delete(this.key(id, action));
      return known && known.attemptId === v.attemptId && v.phase === 'unknown' && v.hash === null ? { ...v, hash: known.hash, phase: known.phase } : v;
    } catch {
      throw new LibraryUiError('STORAGE_BLOCKED');
    }
  }
  retainedHash(id: string, action: LibraryAction) { return this.transient.get(this.key(id, action))?.hash ?? null; }
  assertNoPending(id: string, action: LibraryAction) {
    const record = this.journal(id, action);
    if (record && !['confirmed','reverted'].includes(record.phase)) throw new LibraryUiError('RECOVERY_REQUIRED');
  }
  listJournals(): LibraryJournal[] {
    const store = this.options.storage, prefix = `intracampus.library.v1:${this.deploymentKey}:${this.options.account.toLowerCase()}:`;
    if (typeof store.key !== 'function' || typeof store.length !== 'number') throw new LibraryUiError('STORAGE_BLOCKED');
    const entries: LibraryJournal[] = [];
    for (let i = 0; i < store.length; i++) { const key = store.key(i); if (!key?.startsWith(prefix)) continue;
      const match = /^(0x[0-9a-f]{64}):(approve|reject|confirmReturn|return|settle)$/i.exec(key.slice(prefix.length));
      if (!match) continue; const record = this.journal(match[1], match[2] as StaffAction); if (record) entries.push(record);
    }
    return entries;
  }
  private persist(record: LibraryJournal) {
    try {
      const key = this.key(record.requestId, record.action), raw = JSON.stringify(record);
      this.options.storage.setItem(key, raw); check(this.options.storage.getItem(key) === raw);
    } catch { throw new LibraryUiError('STORAGE_BLOCKED'); }
  }
  private walletReady() {
    const s = this.options.wallet.getSnapshot();
    if (!s.address || !same(s.address, this.options.account) || s.chainId !== BigInt(20261) || !s.canProceed) throw new LibraryUiError('WALLET_SESSION_CHANGED');
  }
  async prepare(id: string, action: LibraryAction, intent?: LibrarySettlementIntent, repairRequestedWei?: string): Promise<LibraryCall> {
    this.walletReady();
    this.assertNoPending(id, action);
    const { api, account, deployment: d } = this.options;
    const role = this.options.role ?? 'STUDENT';
    if ((role === 'LIBRARIAN') !== ['approve','reject','confirmReturn','return','settle'].includes(action)) throw new LibraryUiError('ACTION_UNAVAILABLE');
    if (role === 'LIBRARIAN' && !same(account, d.roles.librarian)) throw new LibraryUiError('WALLET_SESSION_CHANGED');
    await api.session(account, role);
    if (action === 'deposit') await requireLibraryStudentNotHeld(account, api.fetcher);
    const request = await api.getRequest(id);
    const previous = request.transactions.find(tx => tx.action === action);
    if (previous && ['UNKNOWN','SUBMITTED'].includes(previous.status)) throw new LibraryUiError('RECOVERY_REQUIRED');
    const iface = new Interface(d.escrow.abi as InterfaceAbi);
    let amountWei = '0', refundWei = '0', data: string, recipient = account;
    if (action === 'deposit') {
      const i = request.depositIntent, book = d.books.find(b => same(b.bookId, request.bookId));
      if (request.status !== 'AWAITING_DEPOSIT' || !i || !book) throw new LibraryUiError('ACTION_UNAVAILABLE');
      data = iface.encodeFunctionData('deposit', [id, request.bookId]); amountWei = book.depositWei;
      if (i.chainId !== 20261 || !same(i.to, d.escrow.address) || i.data.toLowerCase() !== data.toLowerCase() || i.valueWei !== amountWei) throw new LibraryUiError('INTENT_MISMATCH');
      recipient = d.escrow.address;
    } else if (action === 'refund') {
      if (request.status !== 'EXPIRED_REFUND_DUE' || request.refundStatus !== 'REFUND_DUE') throw new LibraryUiError('ACTION_UNAVAILABLE');
      const terms = d.books.find(b => same(b.bookId, request.bookId));
      if (!terms || request.depositWei !== terms.depositWei) throw new LibraryUiError('INTENT_MISMATCH');
      refundWei = request.depositWei;
      data = iface.encodeFunctionData('claimExpiredRefund', [id]);
    } else if (action === 'payShortfall') {
      const loan = (await api.loans()).find(l => l.requestId === id && same(l.borrower, account));
      if (!loan || loan.status !== 'LOST_SHORTFALL_DUE' || loan.settlement?.outcome !== 'LOST' || BigInt(loan.settlement.shortfallWei) <= BigInt(0)) throw new LibraryUiError('ACTION_UNAVAILABLE');
      const terms = d.books.find(b => same(b.bookId, request.bookId));
      if (!terms || loan.loanId !== id || loan.bookId !== request.bookId || loan.settlement.replacementPriceWei !== terms.replacementPriceWei
        || BigInt(loan.settlement.shortfallWei) !== BigInt(terms.replacementPriceWei) - BigInt(terms.depositWei)) throw new LibraryUiError('INTENT_MISMATCH');
      amountWei = loan.settlement.shortfallWei; data = iface.encodeFunctionData('payShortfall', [id]); recipient = d.treasury;
    } else {
      recipient = verifiedBorrower(request, id, d.escrow.address); refundWei = request.depositWei ?? '0';
      if (action === 'approve' || action === 'reject') {
        if (action === 'approve') {
          if (this.options.wallet.refresh) await this.options.wallet.refresh();
          const time = this.options.wallet.getSnapshot().blockTimestamp;
          if (request.status !== 'PENDING_APPROVAL' || request.approvalDeadline === null || time == null || time >= BigInt(request.approvalDeadline)) throw new LibraryUiError('ACTION_UNAVAILABLE');
        } else if (!['PENDING_APPROVAL','REJECTED_NO_COPY'].includes(request.status)) throw new LibraryUiError('ACTION_UNAVAILABLE');
        data = iface.encodeFunctionData(action, [id]);
      } else {
        const loan = (await api.loans()).find(l => same(l.requestId, id));
        if (!loan || !same(loan.borrower, recipient)) throw new LibraryUiError('INTENT_MISMATCH');
        if (action === 'confirmReturn') {
          if (!['ACTIVE','RETURN_REQUESTED'].includes(loan.status) || loan.returnReceivedAt !== null) throw new LibraryUiError('ACTION_UNAVAILABLE');
          data = iface.encodeFunctionData('confirmPhysicalReturn', [id]);
        } else {
          if (!intent || !same(intent.requestId,id) || !same(intent.loanId,loan.loanId) || !same(intent.borrower,recipient) || intent.chainId !== 20261 || !same(intent.escrow,d.escrow.address) || !same(intent.treasury,d.treasury) || !same(intent.walletCall.to,d.escrow.address) || intent.walletCall.valueWei !== '0' || intent.outcome !== (action === 'return' ? 'RETURNED' : 'LOST')) throw new LibraryUiError('INTENT_MISMATCH');
          const receipt = request.transactions.find(t => t.action === 'confirmReturn' && t.status === 'CONFIRMED' && t.proof?.eventName === 'PhysicalReturnConfirmed' && t.proof.chainId === 20261 && same(t.proof.requestId,id) && same(t.proof.txHash,t.txHash) && same(t.proof.contractAddress,d.escrow.address) && same(t.proof.borrower,recipient));
          if (action === 'return' ? loan.status !== 'SETTLEMENT_PENDING' || loan.returnReceivedAt === null || !receipt : !['ACTIVE','RETURN_REQUESTED'].includes(loan.status) || loan.returnReceivedAt !== null || !!receipt) throw new LibraryUiError('ACTION_UNAVAILABLE');
          const functionName = action === 'return' ? 'settleReturn' : 'settleLost';
          try { if (action === 'return' && (typeof repairRequestedWei !== 'string' || !/^(0|[1-9][0-9]*)$/.test(repairRequestedWei) || BigInt(repairRequestedWei) >= BigInt(2) ** BigInt(256))) throw new Error(); data = iface.encodeFunctionData(functionName, action === 'return' ? [id,repairRequestedWei] : [id]); if (data.toLowerCase() !== intent.walletCall.data.toLowerCase()) throw new Error(); } catch { throw new LibraryUiError('INTENT_MISMATCH'); }
          refundWei = intent.preview.refundWei;
        }
      }
    }
    await api.session(account, role); this.walletReady();
    return { requestId: id, action, amountWei, refundWei, recipient, previousHash: previous?.txHash ?? null, ...(intent ? { settlementIntentId: intent.intentId, intent } : {}), ...(repairRequestedWei !== undefined ? { repairRequestedWei } : {}),
      transaction: { to: d.escrow.address, data, value: `0x${BigInt(amountWei).toString(16)}` } };
  }
  async send(call: LibraryCall): Promise<void> {
    await this.options.lock(this.key(call.requestId, call.action), async () => {
      this.assertNoPending(call.requestId, call.action);
      const fresh = await this.prepare(call.requestId, call.action, call.intent, call.repairRequestedWei);
      if (JSON.stringify(fresh) !== JSON.stringify(call)) throw new LibraryUiError('INTENT_MISMATCH');
      const record: LibraryJournal = { version: 1, attemptId: crypto.randomUUID(), requestId: call.requestId, action: call.action,
        account: this.options.account, deployment: this.deploymentKey, phase: 'unknown', hash: null, previousHash: fresh.previousHash, ...(fresh.settlementIntentId ? { settlementIntentId: fresh.settlementIntentId } : {}) };
      let crossed = false;
      try {
        const hash = await this.options.wallet.sendTransactionWithGuard(this.options.account, fresh.transaction, () => {
          this.walletReady(); this.persist(record); this.transient.delete(this.key(call.requestId, call.action)); crossed = true;
        });
        record.hash = hash; record.phase = 'pending';
        // A quota/storage error after broadcast must never discard the hash already returned by the wallet.
        this.transient.set(this.key(call.requestId, call.action), { ...record });
        this.persist(record);
      } catch (error) {
        if (crossed && error instanceof WalletTransactionError && error.outcome !== 'unknown') {
          // A known refusal/not-sent response is safe to retry. An ambiguous send is never cleared.
          this.options.storage.removeItem(this.key(call.requestId, call.action));
        }
        throw error;
      }
      await this.reconcileUnlocked(call.requestId, call.action);
    });
  }
  async reconcile(id: string, action: LibraryAction, recoveredHash?: string): Promise<LibraryRequest> {
    let result: LibraryRequest | undefined;
    await this.options.lock(this.key(id, action), async () => { result = await this.reconcileUnlocked(id, action, recoveredHash); });
    if (!result) throw new LibraryUiError('RECOVERY_REQUIRED');
    return result;
  }
  private async reconcileUnlocked(id: string, action: LibraryAction, recoveredHash?: string): Promise<LibraryRequest> {
    await this.options.api.session(this.options.account, this.options.role ?? 'STUDENT');
    let record = this.journal(id, action);
    const initialRecord = JSON.stringify(record);
    if (recoveredHash && !bytes32(recoveredHash)) throw new LibraryUiError('INVALID_HASH');
    if (record?.phase === 'unknown' && !record.hash && recoveredHash && record.previousHash && same(recoveredHash, record.previousHash)) throw new LibraryUiError('RECOVERY_REQUIRED');
    // Do not persist an unverified recovery hint: a typo must not poison durable recovery.
    const hash = record?.hash ?? recoveredHash;
    let request = hash ? await this.options.api.track(id, action, hash, record?.settlementIntentId) : await this.options.api.getRequest(id);
    let tx = request.transactions.find(t => t.action === action);
    if (!hash && tx && ['return','settle'].includes(action) && !(record?.previousHash && same(tx.txHash, record.previousHash))) {
      if (!record?.settlementIntentId) throw new LibraryUiError('RECOVERY_REQUIRED');
      const discoveredHash = tx.txHash;
      request = await this.options.api.track(id, action, discoveredHash, record.settlementIntentId);
      tx = request.transactions.find(t => t.action === action && same(t.txHash, discoveredHash));
    }
    if (tx && (!hash || same(tx.txHash, hash)) && !(record?.phase === 'unknown' && !hash && record.previousHash && same(tx.txHash, record.previousHash))) {
      if (tx.status === 'CONFIRMED') {
        const p = tx.proof!;
        const borrower = this.options.role === 'LIBRARIAN' ? verifiedBorrower(request, id, this.options.deployment.escrow.address) : this.options.account;
        const expected = {deposit:'DepositReceived',approve:'LoanApproved',reject:'RequestRejected',refund:'ExpiredRefundClaimed',confirmReturn:'PhysicalReturnConfirmed',return:'ReturnSettled',settle:'LostSettled',payShortfall:'ShortfallPaid'} as const;
        if (!borrower || p.chainId !== 20261 || p.eventName !== expected[action] || !same(p.requestId,id) || !same(p.txHash,tx.txHash) || !same(p.contractAddress, this.options.deployment.escrow.address) || !same(p.borrower, borrower)) throw new LibraryUiError('INTENT_MISMATCH');
      }
      record = { version: 1, attemptId: record?.attemptId ?? crypto.randomUUID(), requestId: id, action, account: this.options.account, deployment: this.deploymentKey,
        hash: tx.txHash, previousHash: record?.previousHash ?? null, phase: tx.status === 'CONFIRMED' ? 'confirmed' : tx.status === 'REVERTED' ? 'reverted' : 'pending', ...(record?.settlementIntentId ? { settlementIntentId: record.settlementIntentId } : {}) };
      if (JSON.stringify(this.journal(id, action)) !== initialRecord) throw new LibraryUiError('RECOVERY_REQUIRED');
      this.transient.set(this.key(id, action), { ...record });
      this.persist(record);
      this.transient.delete(this.key(id, action));
    }
    return request;
  }
}
