'use client';

import { campusNetwork } from '@intracampus/network';
import { useCampusWallet } from '../WalletPanel';
import { CopyButton } from '../../demo-controls';
import { formatWalletBalance } from '../../../lib/chains';
import { libraryBalance } from '../../../lib/library';

export default function LibraryWalletSummary() {
  const { state, controller } = useCampusWallet();
  const correctChain = state.chainId === BigInt(campusNetwork.chainId);
  const balance = state.balanceWei === null ? null : libraryBalance(state.balanceWei);
  return <section className="surface-panel library-wallet" aria-label="Ví và mạng">
    <div className="library-wallet-summary">
      <div className="library-wallet-account"><span className="library-meta-label">Tài khoản đang dùng</span>
        <strong className="library-account-value" translate="no">{state.address ? `${state.address.slice(0, 6)}…${state.address.slice(-4)}` : 'Chưa kết nối'}</strong>
        <span className={correctChain ? 'library-network' : 'library-network library-network-warning'}>
          {correctChain ? 'IntraCampus L1 · 20261' : state.chainId === null ? 'Chưa xác minh mạng' : `Sai mạng · cần IntraCampus 20261`}
        </span>
      </div>
      <div className="library-wallet-balance"><span className="library-meta-label">Số dư ví</span>
        <strong className="library-balance-value">{balance ? `${balance.approximate ? '≈ ' : ''}${balance.label}` : 'Chưa đọc được'}</strong>
        <span className="library-wallet-note">{balance?.approximate ? 'Hiển thị gần đúng · tối đa 4 số thập phân' : 'Tiền trong ví dùng để trả gas và giao dịch'}</span>
      </div>
      <div className="library-wallet-buttons">
        {!state.address && <button type="button" className="primary-cta-btn" onClick={() => void controller.connect()}>Kết nối ví Core</button>}
        {state.address && !correctChain && <button type="button" className="secondary-btn" onClick={() => void controller.switchNetwork()}>Chuyển mạng IntraCampus</button>}
        {state.address && <><CopyButton label="Sao chép địa chỉ" value={state.address} /><button type="button" className="secondary-btn" onClick={() => controller.disconnect()}>Ngắt kết nối</button></>}
      </div>
    </div>
    {state.address && <details className="library-wallet-exact"><summary>Xem địa chỉ và số dư chính xác</summary>
      <dl><dt>Địa chỉ đầy đủ</dt><dd><code translate="no">{state.address}</code></dd>
        <dt>Số dư chính xác</dt><dd>{state.balanceWei === null ? 'Chưa xác minh' : formatWalletBalance(state.balanceWei)}</dd></dl>
    </details>}
    {state.message && <p role="status">{state.message}</p>}
    {state.status === 'no-wallet' && <p role="status">Cài và mở ví Core trong trình duyệt để đăng nhập và ký giao dịch.</p>}
    {state.address && !state.canProceed && <p role="status">Chưa xác minh dữ liệu ví. Kiểm tra mạng và thử đọc lại trước khi giao dịch.</p>}
  </section>;
}
