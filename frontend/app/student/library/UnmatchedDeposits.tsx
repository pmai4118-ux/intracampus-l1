'use client';
import { useEffect, useRef, useState } from 'react';
import { Interface } from 'ethers';
import { CAMPUS_CHAIN_ID, getLibraryDeployment, type LibraryUnmatchedDeposit } from '@intracampus/network';
import { useCampusWallet } from '../WalletPanel';
import { LibraryApi, LibraryUiError, bytes32 } from '../../../lib/library-api';
import { formatWalletBalance } from '../../../lib/chains';
import { libraryDate, libraryError, unmatchedRecoveryAllowed, type UnmatchedRefundJournal } from '../../../lib/library';
import { WalletTransactionError } from '../../../lib/wallet';

export default function UnmatchedDeposits({ api, refreshVersion }: { api: LibraryApi; refreshVersion: number }) {
  const { state: wallet } = useCampusWallet();
  const [deposits, setDeposits] = useState<LibraryUnmatchedDeposit[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    void api.unmatchedDeposits().then(rows => { if (current) { setDeposits(rows); setError(''); } })
      .catch(e => { if (current) setError(libraryError(e)); });
    return () => { current = false; };
  }, [api, refreshVersion]);
  if (deposits.length === 0 && !error) return null;
  return <section className="surface-panel library-section" aria-label="Cọc cần xử lý riêng">
    <h2>Cọc cần xử lý riêng</h2><p>Các khoản cọc này đã được xác minh trên mạng nhưng không khớp yêu cầu mượn. Chúng không tạo khoản mượn. Tiền hoàn luôn về ví thực sự đã nộp.</p>
    {error && <p role="alert">{error}</p>}
    {deposits.filter(d => d.borrower.toLowerCase() === wallet.address?.toLowerCase()).map(deposit => <Refund key={deposit.requestId} initial={deposit} api={api} />)}
  </section>;
}

type Journal = UnmatchedRefundJournal;
function Refund({ initial, api }: { initial: LibraryUnmatchedDeposit; api: LibraryApi }) {
  const { state: wallet, controller } = useCampusWallet();
  const [deposit, setDeposit] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [candidate, setCandidate] = useState(''), [review, setReview] = useState(false), [journal, setJournal] = useState<Journal | null>(null);
  const alive = useRef(true), operating = useRef(false);
  const key = `intracampus.library.unmatched:${initial.depositProof.contractAddress.toLowerCase()}:${initial.borrower.toLowerCase()}:${initial.requestId}`;
  useEffect(() => { setDeposit(initial); }, [initial]);
  useEffect(() => {
    alive.current = true;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const j = JSON.parse(raw) as Journal;
        if (!['unknown', 'pending', 'reverted'].includes(j.phase) || (j.hash !== null && !bytes32(j.hash))
          || (j.previousHashes !== undefined && (!Array.isArray(j.previousHashes) || !j.previousHashes.every(bytes32)))) throw new Error();
        setJournal(j);
      }
    } catch { setError('Không đọc được nhật ký. Giữ mã giao dịch từ ví và đối chiếu trước khi ký thêm.'); setJournal({ phase: 'unknown', hash: null }); }
    return () => { alive.current = false; };
  }, [key]);
  function persist(next: Journal) {
    localStorage.setItem(key, JSON.stringify(next));
    if (localStorage.getItem(key) !== JSON.stringify(next)) throw new LibraryUiError('STORAGE_BLOCKED');
    if (alive.current) setJournal(next);
  }
  async function run(work: () => Promise<void>) {
    if (operating.current) return;
    operating.current = true; setBusy(true); setError('');
    try {
      if (!navigator.locks) throw new LibraryUiError('LOCK_UNAVAILABLE');
      await navigator.locks.request(key, work);
    } catch (e) { if (alive.current) setError(libraryError(e)); }
    finally { operating.current = false; if (alive.current) setBusy(false); }
  }
  async function reconcile(hash: string) {
    if (!bytes32(hash)) throw new LibraryUiError('INVALID_HASH');
    const raw = localStorage.getItem(key);
    const current = raw ? JSON.parse(raw) as Journal : journal;
    if (!current || !unmatchedRecoveryAllowed(current, hash)) throw new LibraryUiError('RECOVERY_REQUIRED');
    await api.session(initial.borrower);
    const result = await api.trackUnmatched(deposit.requestId, hash);
    if (localStorage.getItem(key) !== raw) throw new LibraryUiError('RECOVERY_REQUIRED');
    if (!alive.current) return;
    const deployment = getLibraryDeployment();
    const walletNow = controller.getSnapshot();
    if (deployment.status !== 'deployed' || walletNow.chainId !== BigInt(CAMPUS_CHAIN_ID)
      || walletNow.address?.toLowerCase() !== initial.borrower.toLowerCase()
      || result.deposit.requestId !== initial.requestId || result.deposit.bookId !== initial.bookId
      || result.deposit.borrower.toLowerCase() !== initial.borrower.toLowerCase()
      || result.deposit.amountWei !== initial.amountWei
      || result.deposit.depositProof.txHash.toLowerCase() !== initial.depositProof.txHash.toLowerCase()
      || result.deposit.depositProof.contractAddress.toLowerCase() !== deployment.escrow.address.toLowerCase()
      || initial.depositProof.contractAddress.toLowerCase() !== deployment.escrow.address.toLowerCase()) throw new LibraryUiError('INTENT_MISMATCH');
    setDeposit(result.deposit);
    if (result.status === 'CONFIRMED' && result.deposit.refundProof?.txHash.toLowerCase() === hash.toLowerCase()) {
      localStorage.removeItem(key); setJournal(null);
    } else if (result.status === 'REVERTED') persist({ ...current, phase: 'reverted', hash });
    else persist({ ...current, phase: 'pending', hash });
  }
  async function send() {
    const raw = localStorage.getItem(key);
    const previous = raw ? JSON.parse(raw) as Journal : journal;
    if (previous && previous.phase !== 'reverted') throw new LibraryUiError('RECOVERY_REQUIRED');
    if (journal && journal.phase !== 'reverted') throw new LibraryUiError('RECOVERY_REQUIRED');
    await api.session(initial.borrower);
    const fresh = (await api.unmatchedDeposits()).find(d => d.requestId === initial.requestId);
    const d = getLibraryDeployment();
    if (!fresh || d.status !== 'deployed' || fresh.refundProof || !fresh.refundIntent) throw new LibraryUiError('ACTION_UNAVAILABLE');
    const intent = fresh.refundIntent;
    const expected = new Interface(d.escrow.abi).encodeFunctionData('claimExpiredRefund', [fresh.requestId]);
    const ready = () => {
      const current = controller.getSnapshot();
      if (!alive.current || !current.canProceed || current.chainId !== BigInt(CAMPUS_CHAIN_ID) || current.address?.toLowerCase() !== fresh.borrower.toLowerCase()) throw new LibraryUiError('WALLET_SESSION_CHANGED');
    };
    ready();
    if (intent.chainId !== CAMPUS_CHAIN_ID || intent.to.toLowerCase() !== d.escrow.address.toLowerCase()
      || fresh.depositProof.contractAddress.toLowerCase() !== d.escrow.address.toLowerCase()
      || intent.data.toLowerCase() !== expected.toLowerCase() || intent.valueWei !== '0') throw new LibraryUiError('INTENT_MISMATCH');
    const previousHashes = [...new Set([...(previous?.previousHashes ?? []), ...(previous?.hash ? [previous.hash] : [])])];
    await api.session(initial.borrower);
    try {
      const hash = await controller.sendTransactionWithGuard(fresh.borrower, { to: intent.to, data: intent.data, value: '0x0' }, () => {
        ready(); persist({ phase: 'unknown', hash: null, previousHashes });
      });
      persist({ phase: 'pending', hash, previousHashes });
      await reconcile(hash);
    } catch (e) {
      if (e instanceof WalletTransactionError && e.outcome !== 'unknown') {
        if (previous) persist(previous);
        else { localStorage.removeItem(key); if (alive.current) setJournal(null); }
      }
      throw e;
    } finally { if (alive.current) setReview(false); }
  }
  return <article className="library-record"><h3>Cọc {formatWalletBalance(BigInt(deposit.amountWei))}</h3>
    <p>{deposit.refundProof ? 'Đã xác minh hoàn cọc về ví đã nộp.' : journal?.phase === 'reverted' ? 'Lượt hoàn cọc thất bại. Đọc lại điều kiện trước khi thử lại.' : journal ? 'Lượt hoàn cọc chưa xác minh. Không gửi lại.' : deposit.latestEvent === 'DepositReceived' ? `Có thể nhận lại cọc từ ${libraryDate(deposit.approvalDeadline)}.` : 'Khoản cọc đã có thao tác khác trên mạng. Liên hệ thủ thư để đối chiếu trước khi tiếp tục.'}</p>
    {deposit.refundProof && journal?.phase === 'reverted' && <p>Lượt ký hoàn cọc của bạn đã thất bại. Khoản cọc được hoàn bởi giao dịch khác đã xác minh.</p>}
    <details><summary>Chi tiết khoản cọc</summary><p>Mã yêu cầu <code>{deposit.requestId}</code></p><p>Ví nhận hoàn <code>{deposit.borrower}</code></p><p>Giao dịch cọc <code>{deposit.depositProof.txHash}</code></p>{deposit.refundProof && <p>Giao dịch hoàn <code>{deposit.refundProof.txHash}</code></p>}</details>
    {error && <p role="alert">{error}</p>}
    {journal && <form onSubmit={e => { e.preventDefault(); void run(() => reconcile(journal.hash ?? candidate.trim())); }}>
      <label>Mã giao dịch hoàn từ lịch sử ví <input value={journal.hash ?? candidate} readOnly={journal.hash !== null} onChange={e => setCandidate(e.target.value)} autoComplete="off" spellCheck={false} /></label>
      <button type="submit" className="secondary-btn" disabled={busy}>Đối chiếu hoàn cọc</button></form>}
    {!deposit.refundProof && deposit.refundIntent && (!journal || journal.phase === 'reverted') && !review && <button type="button" className="secondary-btn" disabled={busy || !wallet.canProceed} onClick={() => setReview(true)}>Xem hoàn cọc riêng</button>}
    {review && <div role="region" aria-label="Kiểm tra hoàn cọc riêng"><p>Hoàn {formatWalletBalance(BigInt(deposit.amountWei))} về ví đã nộp <code>{deposit.borrower}</code>. Mạng IntraCampus {CAMPUS_CHAIN_ID}. Không gửi thêm CAMPUS, ví trả gas riêng.</p><div className="library-actions"><button type="button" className="primary-cta-btn" disabled={busy} onClick={() => void run(send)}>Xác nhận và mở ví</button><button type="button" className="secondary-btn" disabled={busy} onClick={() => setReview(false)}>Hủy</button></div></div>}
  </article>;
}
