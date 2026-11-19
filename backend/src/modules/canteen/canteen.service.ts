import { Interface, id, type InterfaceAbi } from 'ethers';
import { requireDeployment, type SignedInvoiceEnvelope } from '@intracampus/network';
import type { CanteenOrder } from '@intracampus/network';
import { CanteenRepository, CanteenError } from './canteen.repository.ts';
import type { InvoiceCreationService } from '../invoices/invoices.service.ts';
import type { ReceiptService } from '../invoices/receipt.service.ts';
import type { InvoiceRpc } from '../invoices/invoices.rpc.ts';
import type { GrantsService } from '../grants/grants.service.ts';
const same = (a: unknown,b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
export class CanteenService {
  repository: CanteenRepository;
  private options: { manifest?: unknown; allowLocal?: boolean; rpc: InvoiceRpc;
    invoices: InvoiceCreationService; receipts: ReceiptService; grants: GrantsService };
  constructor(repository: CanteenRepository, options: CanteenService["options"]) { this.repository = repository; this.options = options; }
  private deployment() { try { return requireDeployment(this.options.manifest, { allowLocal: this.options.allowLocal }); }
    catch { throw new CanteenError('CONFIGURATION_ERROR',503); } }
  async reconcileWallet(order: CanteenOrder): Promise<CanteenOrder> {
    if (order.method !== 'WALLET' || order.status === 'PAID' || !order.invoiceId) return order;
    const result = await this.options.receipts.lookup(order.invoiceId);
    if (result.body.status === 'paid') return this.track(order,result.body.receipt.txHash);
    if (result.body.status === 'expired' && !order.txHash) return this.repository.expire(order.id,order.wallet);
    return order;
  }
  async prepare(order: CanteenOrder): Promise<{ order: CanteenOrder; envelope: SignedInvoiceEnvelope | null }> {
    const manifest = this.deployment();
    order = await this.reconcileWallet(order);
    if (order.status === 'PAID' || order.status === 'EXPIRED') return { order, envelope: null };
    const chain = await this.options.rpc.call('eth_chainId',[]);
    if (BigInt(String(chain)) !== 20261n) throw new CanteenError('WRONG_CHAIN',503);
    const block = await this.options.rpc.call('eth_getBlockByNumber',['latest',false]) as { number: string; timestamp: string };
    const blockNumber = Number(BigInt(block.number));
    if (!Number.isSafeInteger(blockNumber) || Math.abs(Date.now()/1000 - Number(BigInt(block.timestamp))) > 300) throw new CanteenError('STALE_CHAIN_STATE',503);
    let envelope: SignedInvoiceEnvelope | null = null;
    if (order.method === 'WALLET') {
      const result = await this.options.invoices.createForService({ merchantId: 'canteen', merchantName: 'Nhà ăn IntraCampus',
        serviceId: order.id, serviceName: 'Đơn món ăn', categoryCode: 'FOOD', amount: BigInt(order.totalWei), ttlSeconds: 300 },
        manifest.merchants.canteen.address, `CANTEEN-${order.id}`);
      envelope = result.envelope;
    } else {
      const lookup = await this.options.grants.lookup(order.wallet);
      if (!lookup.allowedMerchants.some(m => m.allowed && same(m.address,manifest.merchants.canteen.address))) throw new CanteenError('MERCHANT_NOT_ALLOWED',409);
      if (BigInt(lookup.balanceWei) < BigInt(order.totalWei)) throw new CanteenError('INSUFFICIENT_FOOD',409);
    }
    return { order: this.repository.prepare(order.id,order.wallet,blockNumber,envelope?.invoice.invoiceId ?? null), envelope };
  }
  async track(order: CanteenOrder, txHash: string) {
    if (!/^0x[0-9a-f]{64}$/i.test(txHash)) throw new CanteenError('INVALID_HASH');
    txHash = txHash.toLowerCase();
    if (order.status === 'PAID') { if (order.txHash !== txHash) throw new CanteenError('PAYMENT_ALREADY_TRACKED',409); return order; }
    if (order.afterBlock === null) throw new CanteenError('PAYMENT_NOT_PREPARED',409);
    const manifest = this.deployment();
    // Check sender and destination before reserving a user-supplied hash.
    const tx = await this.options.rpc.call('eth_getTransactionByHash',[txHash]) as null | { from: string; to: string; input: string; value: string; blockNumber: string | null };
    if (!tx) throw new CanteenError('TRANSACTION_NOT_FOUND',503);
    const target = order.method === 'FOOD' ? manifest.contracts.PurposeBoundGrantVault.address : manifest.contracts.CampusPaymentRegistry.address;
    if (!same(tx.from,order.wallet) || !same(tx.to,target)) throw new CanteenError('RECEIPT_MISMATCH',422);
    if (order.method === 'FOOD') {
      const iface = new Interface(manifest.contracts.PurposeBoundGrantVault.abi as InterfaceAbi);
      const expected = iface.encodeFunctionData('spend',[manifest.merchants.canteen.address,id('FOOD'),order.totalWei]);
      if (!same(tx.input,expected) || BigInt(tx.value) !== 0n) throw new CanteenError('RECEIPT_MISMATCH',422);
    }
    if (tx.blockNumber !== null && Number(BigInt(tx.blockNumber)) <= order.afterBlock) throw new CanteenError('RECEIPT_MISMATCH',422);
    order = this.repository.claim(order.id,order.wallet,txHash);
    if (order.method === 'WALLET') {
      const result = await this.options.receipts.lookup(order.invoiceId!,txHash);
      if (result.body.status !== 'paid') {
        if (result.httpStatus !== 200) throw new CanteenError(result.body.error?.code ?? 'RPC_UNAVAILABLE',result.httpStatus);
        return order;
      }
      const receipt = result.body.receipt;
      if (!same(receipt.payer,order.wallet) || !same(receipt.txHash,txHash) || !same(receipt.merchant,manifest.merchants.canteen.address)
        || !same(receipt.category,id('FOOD')) || receipt.originalAmount !== order.totalWei) throw new CanteenError('RECEIPT_MISMATCH',422);
      return this.repository.confirm(order.id,order.wallet,txHash,receipt.paidAmount);
    }
    const result = await this.options.grants.lookup(order.wallet,txHash);
    if (result.transaction?.status !== 'verified') return order;
    const events = result.transaction.events.filter(e => e.event === 'GrantSpent' && same(e.beneficiary,order.wallet)
      && same(e.merchant,manifest.merchants.canteen.address) && same(e.category,id('FOOD')) && e.amountWei === order.totalWei && e.blockNumber > order.afterBlock!);
    if (events.length !== 1) throw new CanteenError('RECEIPT_MISMATCH',422);
    return this.repository.confirm(order.id,order.wallet,txHash,order.totalWei);
  }
  async staffOverview() {
    let merchantWallet: string | null = null;
    try { merchantWallet = this.deployment().merchants.canteen.address; } catch { merchantWallet = null; }
    const initial = this.repository.listAllWithFulfillment();
    const pendingWallet = initial.filter(o => o.status === 'AWAITING_PAYMENT' && o.method === 'WALLET' && o.invoiceId !== null).slice(0, 8);
    for (const candidate of pendingWallet) {
      try { await this.reconcileWallet(candidate); } catch { /* Best-effort background check for counter screen */ }
    }
    const orders = this.repository.listAllWithFulfillment().map(({ wallet, ...rest }) => ({
      ...rest,
      payerHint: `${wallet.slice(0, 6)}…${wallet.slice(-4)}`,
    }));
    return {
      merchantWallet,
      dishes: this.repository.menu(),
      orders,
    };
  }
}
