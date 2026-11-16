import { campusNetwork, type LibraryBook, type LibraryRequest, type LibraryLoan, type LibrarySession,
  type LibraryEventProof, type LibraryTransaction, type LibraryTransactionAction, type LibraryRole,
  type LibrarySettlementIntent, type LibrarySettlementIntentRequest } from '@intracampus/network';
import { parseAccountStatus } from './library-session.ts';

export class LibraryUiError extends Error {
  readonly code: string;
  readonly retryAfterSeconds?: number;
  constructor(code: string, retryAfterSeconds?: number) { super(code); this.code = code; this.retryAfterSeconds = retryAfterSeconds; }
}
export function check(condition: unknown): asserts condition { if (!condition) throw new LibraryUiError('INVALID_RESPONSE'); }
export function object(value: unknown): Record<string, any> { check(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, any>; }
export const bytes32 = (v: unknown): v is `0x${string}` => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v);
export const wei = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) < BigInt(2) ** BigInt(256);
export const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export const address = (v: unknown): v is `0x${string}` => typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) && !/^0x0{40}$/i.test(v);
export const libraryIntentId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && v.trim() === v;
const requestStates = ['AWAITING_DEPOSIT','PENDING_APPROVAL','REJECTED_NO_COPY','REJECTED','EXPIRED_REFUND_DUE','APPROVED','RETURN_REQUESTED','SETTLEMENT_PENDING','RETURNED','LOST_SHORTFALL_DUE','LOST_SETTLED'];
const eventForAction = {
  deposit: 'DepositReceived', approve: 'LoanApproved', reject: 'RequestRejected', refund: 'ExpiredRefundClaimed',
  confirmReturn: 'PhysicalReturnConfirmed', return: 'ReturnSettled', settle: 'LostSettled', payShortfall: 'ShortfallPaid',
} as const satisfies Record<LibraryTransactionAction, LibraryEventProof['eventName']>;

export function libraryTransactionProof(tx: LibraryTransaction | undefined, requestId: string, escrow: string, borrower?: string) {
  const proof = tx?.proof;
  if (tx?.status !== 'CONFIRMED' || !proof || proof.chainId !== campusNetwork.chainId || proof.eventName !== eventForAction[tx.action]
    || proof.requestId !== requestId || proof.txHash !== tx.txHash || proof.contractAddress.toLowerCase() !== escrow.toLowerCase()
    || (borrower && proof.borrower.toLowerCase() !== borrower.toLowerCase())) return null;
  return proof;
}
export function parseLibraryBook(value: unknown): LibraryBook {
  const v = object(value);
  check(bytes32(v.bookId) && typeof v.title === 'string' && typeof v.author === 'string' && (v.isbn === null || typeof v.isbn === 'string')
    && wei(v.depositWei) && wei(v.replacementPriceWei) && timestamp(v.copiesTotal) && timestamp(v.copiesAvailable) && v.copiesAvailable <= v.copiesTotal);
  return v as LibraryBook;
}
export function parseLibraryRequest(value: unknown): LibraryRequest {
  const v = object(value);
  check(bytes32(v.requestId) && bytes32(v.bookId) && requestStates.includes(v.status) && ['NONE','REFUND_DUE','REFUNDED'].includes(v.refundStatus)
    && (v.depositWei === null || wei(v.depositWei)) && (v.loanId === null || bytes32(v.loanId))
    && (v.approvalDeadline === null || timestamp(v.approvalDeadline)) && timestamp(v.createdAt) && timestamp(v.updatedAt) && Array.isArray(v.transactions));
  if (v.depositIntent !== null) {
    const i = object(v.depositIntent);
    check(i.chainId === campusNetwork.chainId && address(i.to) && typeof i.data === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(i.data)
      && wei(i.valueWei) && i.requestId === v.requestId && i.bookId === v.bookId);
  }
  for (const item of v.transactions) {
    const tx = object(item);
    check(typeof tx.action === 'string' && Object.hasOwn(eventForAction, tx.action)
      && bytes32(tx.txHash) && ['UNKNOWN','SUBMITTED','CONFIRMED','REVERTED'].includes(tx.status) && timestamp(tx.submittedAt));
    if (tx.status === 'CONFIRMED') {
      const p = object(tx.proof);
      check(p.chainId === campusNetwork.chainId && p.eventName === eventForAction[tx.action as LibraryTransactionAction]
        && address(p.contractAddress) && p.requestId === v.requestId && p.txHash === tx.txHash
        && address(p.borrower) && bytes32(p.blockHash) && timestamp(p.blockNumber) && timestamp(p.logIndex));
    } else check(tx.proof === null);
  }
  return v as LibraryRequest;
}
export function parseLibraryLoan(value: unknown): LibraryLoan {
  const v = object(value);
  check(bytes32(v.loanId) && bytes32(v.requestId) && bytes32(v.bookId) && address(v.borrower)
    && ['ACTIVE','RETURN_REQUESTED','SETTLEMENT_PENDING','RETURNED','LOST_SHORTFALL_DUE','LOST_SETTLED'].includes(v.status)
    && timestamp(v.approvedAt) && timestamp(v.dueAt) && (v.returnRequestedAt === null || timestamp(v.returnRequestedAt))
    && (v.returnReceivedAt === null || timestamp(v.returnReceivedAt)));
  if (v.settlement !== null) {
    const s = object(v.settlement);
    const fields = s.outcome === 'RETURNED' ? ['lateFeeWei','repairFeeWei','overdueForfeitWei','totalRetainedWei','refundWei'] : ['replacementPriceWei','totalRetainedWei','refundWei','shortfallWei'];
    check(['RETURNED','LOST'].includes(s.outcome) && fields.every(key => wei(s[key])));
    if (s.outcome === 'RETURNED') check(timestamp(s.returnedAt) && typeof s.maintenanceRequired === 'boolean');
  }
  return v as LibraryLoan;
}
function list<T>(value: unknown, parser: (v: unknown) => T): T[] { check(Array.isArray(value)); return value.map(parser); }
export function parseSettlementIntent(value: unknown): LibrarySettlementIntent {
  const v = object(value), call = object(v.walletCall), preview = object(v.preview);
  check(libraryIntentId(v.intentId) && bytes32(v.loanId) && bytes32(v.requestId)
    && address(v.borrower) && address(v.escrow) && address(v.treasury) && v.chainId === campusNetwork.chainId && timestamp(v.chainTime)
    && address(call.to) && typeof call.data === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(call.data) && wei(call.valueWei)
    && ['RETURNED','LOST'].includes(v.outcome) && preview.outcome === v.outcome);
  const fields = v.outcome === 'RETURNED' ? ['lateFeeWei','repairFeeWei','overdueForfeitWei','totalRetainedWei','refundWei'] : ['replacementPriceWei','totalRetainedWei','refundWei','shortfallWei'];
  check(fields.every(key => wei(preview[key])));
  if (v.outcome === 'RETURNED') check(timestamp(preview.returnedAt) && typeof preview.maintenanceRequired === 'boolean');
  return v as LibrarySettlementIntent;
}
export class LibraryApi {
  readonly fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = fetch) { this.fetcher = (input, init) => fetcher(input, init); }
  async request(path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try { response = await this.fetcher(path, { credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }); }
    catch { throw new LibraryUiError('RPC_UNAVAILABLE'); }
    let data: unknown;
    try { data = await response.json(); } catch { throw new LibraryUiError('INVALID_RESPONSE'); }
    if (!response.ok) {
      const v = object(data);
      throw new LibraryUiError(typeof v.error?.code === 'string' ? v.error.code : 'INVALID_RESPONSE', Number(response.headers.get('retry-after')) || undefined);
    }
    return data;
  }
  async session(wallet: string, role: LibraryRole = 'STUDENT'): Promise<LibrarySession> {
    const s = object(await this.request('/api/auth/session'));
    check(address(s.account?.wallet) && ['STUDENT','LIBRARIAN'].includes(s.account.role) && timestamp(s.expiresAt));
    if (s.account.wallet.toLowerCase() !== wallet.toLowerCase() || s.account.role !== role) throw new LibraryUiError('WALLET_SESSION_CHANGED');
    return s as LibrarySession;
  }
  async books(q = '') { return list(await this.request(`/api/library/books?q=${encodeURIComponent(q)}`), parseLibraryBook); }
  async requests(queue = false) { return list(await this.request(`/api/library/requests${queue ? '?queue=true' : ''}`), parseLibraryRequest); }
  async accountStatus() { return parseAccountStatus(await this.request('/api/library/account-status')); }
  async getRequest(id: string) { check(bytes32(id)); const r = parseLibraryRequest(await this.request(`/api/library/requests/${id}`)); check(r.requestId === id); return r; }
  async create(bookId: string, idempotencyKey: string) { return parseLibraryRequest(await this.request('/api/library/requests', { bookId, idempotencyKey })); }
  async loans() { return list(await this.request('/api/library/loans'), parseLibraryLoan); }
  async settlementIntent(id: string, input: LibrarySettlementIntentRequest) { check(bytes32(id)); const result = parseSettlementIntent(await this.request(`/api/library/loans/${id}/settlement-intents`, input)); check(result.loanId === id && result.outcome === input.outcome); return result; }
  async track(id: string, action: LibraryTransactionAction, txHash: string, settlementIntentId?: string) {
    check(bytes32(id) && bytes32(txHash));
    const result = object(await this.request(`/api/library/requests/${id}/transactions`, { action, txHash, ...(settlementIntentId ? { settlementIntentId } : {}) }));
    const request = parseLibraryRequest(result.request);
    check(request.requestId === id);
    return request;
  }
  async returnBook(id: string) { check(bytes32(id)); await this.request(`/api/library/loans/${id}/return-requests`, {}); }
}
