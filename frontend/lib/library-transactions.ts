import { Interface, type InterfaceAbi } from 'ethers';
import type { DeployedLibraryDeployment, LibraryRequest } from '@intracampus/network';
import type { WalletSnapshot, WalletTransaction } from './wallet.ts';
import { WalletTransactionError } from './wallet.ts';
import { requireLibraryStudentNotHeld } from './library-session.ts';
import { LibraryApi, LibraryUiError, bytes32, check } from './library-api.ts';

export type StudentAction = 'deposit' | 'refund' | 'payShortfall';
export type LibraryCall = { requestId: string; action: StudentAction; transaction: WalletTransaction; amountWei: string; recipient: string; refundWei: string; previousHash: string | null };
export type LibraryJournal = { version: 1; attemptId: string; requestId: string; action: StudentAction; account: string; deployment: string;
  phase: 'unknown' | 'pending' | 'confirmed' | 'reverted'; hash: string | null; previousHash: string | null };
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Sender = { getSnapshot(): Pick<WalletSnapshot, 'address' | 'chainId' | 'canProceed'>;
  sendTransactionWithGuard(account: string, transaction: WalletTransaction, guard: () => void): Promise<string> };
type Options = { deployment: DeployedLibraryDeployment; account: string; api: LibraryApi; wallet: Sender; storage: Store;
  lock: (key: string, run: () => Promise<void>) => Promise<void> };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export class LibraryTransactions {
  readonly options: Options;
  readonly deploymentKey: string;
  private readonly transient = new Map<string, LibraryJournal>();
  constructor(options: Options) {
    this.options = options;
    this.deploymentKey = `20261:${options.deployment.escrow.address.toLowerCase()}:${options.deployment.escrow.transactionHash.toLowerCase()}`;
  }
  key(id: string, action: StudentAction) { return `intracampus.library.v1:${this.deploymentKey}:${this.options.account.toLowerCase()}:${id}:${action}`; }
  journal(id: string, action: StudentAction): LibraryJournal | null {
    try {
      const raw = this.options.storage.getItem(this.key(id, action)); if (raw === null) return this.transient.get(this.key(id, action)) ?? null;
      const v = JSON.parse(raw);
      check(v.version === 1 && typeof v.attemptId === 'string' && v.attemptId.length > 0 && v.requestId === id && v.action === action && same(v.account, this.options.account)
        && v.deployment === this.deploymentKey && ['unknown','pending','confirmed','reverted'].includes(v.phase)
        && (v.hash === null || bytes32(v.hash)) && (v.previousHash === null || bytes32(v.previousHash)));
      const known = this.transient.get(this.key(id, action));
      if (known && known.attemptId !== v.attemptId) this.transient.delete(this.key(id, action));
      return known && known.attemptId === v.attemptId && v.phase === 'unknown' && v.hash === null ? { ...v, hash: known.hash, phase: known.phase } : v;
    } catch {
      throw new LibraryUiError('STORAGE_BLOCKED');
    }
  }
  retainedHash(id: string, action: StudentAction) { return this.transient.get(this.key(id, action))?.hash ?? null; }
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
  async prepare(id: string, action: StudentAction): Promise<LibraryCall> {
    this.walletReady();
    const { api, account, deployment: d } = this.options;
    await api.session(account);
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
    } else {
      const loan = (await api.loans()).find(l => l.requestId === id && same(l.borrower, account));
      if (!loan || loan.status !== 'LOST_SHORTFALL_DUE' || loan.settlement?.outcome !== 'LOST' || BigInt(loan.settlement.shortfallWei) <= BigInt(0)) throw new LibraryUiError('ACTION_UNAVAILABLE');
      const terms = d.books.find(b => same(b.bookId, request.bookId));
      if (!terms || loan.loanId !== id || loan.bookId !== request.bookId || loan.settlement.replacementPriceWei !== terms.replacementPriceWei
        || BigInt(loan.settlement.shortfallWei) !== BigInt(terms.replacementPriceWei) - BigInt(terms.depositWei)) throw new LibraryUiError('INTENT_MISMATCH');
      amountWei = loan.settlement.shortfallWei; data = iface.encodeFunctionData('payShortfall', [id]); recipient = d.treasury;
    }
    await api.session(account); this.walletReady();
    return { requestId: id, action, amountWei, refundWei, recipient, previousHash: previous?.txHash ?? null,
      transaction: { to: d.escrow.address, data, value: `0x${BigInt(amountWei).toString(16)}` } };
  }
  async send(call: LibraryCall): Promise<void> {
    await this.options.lock(this.key(call.requestId, call.action), async () => {
      const previous = this.journal(call.requestId, call.action);
      if (previous && !['confirmed','reverted'].includes(previous.phase)) throw new LibraryUiError('RECOVERY_REQUIRED');
      const fresh = await this.prepare(call.requestId, call.action);
      if (JSON.stringify(fresh) !== JSON.stringify(call)) throw new LibraryUiError('INTENT_MISMATCH');
      const record: LibraryJournal = { version: 1, attemptId: crypto.randomUUID(), requestId: call.requestId, action: call.action,
        account: this.options.account, deployment: this.deploymentKey, phase: 'unknown', hash: null, previousHash: fresh.previousHash };
      let crossed = false;
      try {
        const hash = await this.options.wallet.sendTransactionWithGuard(this.options.account, fresh.transaction, () => {
          this.persist(record); this.transient.delete(this.key(call.requestId, call.action)); crossed = true;
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
  async reconcile(id: string, action: StudentAction, recoveredHash?: string): Promise<LibraryRequest> {
    let result: LibraryRequest | undefined;
    await this.options.lock(this.key(id, action), async () => { result = await this.reconcileUnlocked(id, action, recoveredHash); });
    if (!result) throw new LibraryUiError('RECOVERY_REQUIRED');
    return result;
  }
  private async reconcileUnlocked(id: string, action: StudentAction, recoveredHash?: string): Promise<LibraryRequest> {
    await this.options.api.session(this.options.account);
    let record = this.journal(id, action);
    const initialRecord = JSON.stringify(record);
    if (recoveredHash && !bytes32(recoveredHash)) throw new LibraryUiError('INVALID_HASH');
    if (record?.phase === 'unknown' && !record.hash && recoveredHash && record.previousHash && same(recoveredHash, record.previousHash)) throw new LibraryUiError('RECOVERY_REQUIRED');
    // Do not persist an unverified recovery hint: a typo must not poison durable recovery.
    const hash = record?.hash ?? recoveredHash;
    const request = hash ? await this.options.api.track(id, action, hash) : await this.options.api.getRequest(id);
    const tx = request.transactions.find(t => t.action === action);
    if (tx && (!hash || same(tx.txHash, hash)) && !(record?.phase === 'unknown' && !hash && record.previousHash && same(tx.txHash, record.previousHash))) {
      if (tx.status === 'CONFIRMED') {
        const p = tx.proof!;
        if (!same(p.contractAddress, this.options.deployment.escrow.address) || !same(p.borrower, this.options.account)) throw new LibraryUiError('INTENT_MISMATCH');
      }
      record = { version: 1, attemptId: record?.attemptId ?? crypto.randomUUID(), requestId: id, action, account: this.options.account, deployment: this.deploymentKey,
        hash: tx.txHash, previousHash: record?.previousHash ?? null, phase: tx.status === 'CONFIRMED' ? 'confirmed' : tx.status === 'REVERTED' ? 'reverted' : 'pending' };
      if (JSON.stringify(this.journal(id, action)) !== initialRecord) throw new LibraryUiError('RECOVERY_REQUIRED');
      this.transient.set(this.key(id, action), { ...record });
      this.persist(record);
      this.transient.delete(this.key(id, action));
    }
    return request;
  }
}
