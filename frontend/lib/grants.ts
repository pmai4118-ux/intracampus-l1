import { requireDeployment, type DeployedManifest } from "@intracampus/network";
import { isWalletAddress } from "./chains.ts";
import type { WalletRpc } from "./wallet.ts";

const UINT_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);
const same = (value: unknown, expected: string) => typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
const hash = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const money = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) <= UINT_MAX;
function check(condition: unknown, code = "INVALID_GRANT_RESPONSE"): asserts condition { if (!condition) throw new GrantUiError(code); }
function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function quantity(value: unknown): bigint {
  check(typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value), "RPC_UNAVAILABLE");
  return BigInt(value);
}
function word(value: string) { check(isWalletAddress(value), "INVALID_ACCOUNT"); return value.slice(2).toLowerCase().padStart(64, "0"); }
function uintWord(value: bigint) { check(value > BigInt(0) && value <= UINT_MAX, "INVALID_AMOUNT"); return value.toString(16).padStart(64, "0"); }
function rpcUint(value: unknown) { check(typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value), "RPC_UNAVAILABLE"); return BigInt(value); }

export class GrantUiError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "GrantUiError"; this.code = code; }
}
export type GrantConfig = { vault: string; registry: string; issuer: string; merchant: string; category: string; deploymentHash: string };
/** The full L05 ABI is validated by the shared L06 loader before using these static selectors. */
export function grantConfig(manifest?: unknown): GrantConfig {
  const data: DeployedManifest = requireDeployment(manifest);
  return { vault: data.contracts.PurposeBoundGrantVault.address, registry: data.contracts.CampusPaymentRegistry.address,
    issuer: data.roles.grantIssuer, merchant: data.merchants.canteen.address, category: data.merchants.canteen.category,
    deploymentHash: data.contracts.PurposeBoundGrantVault.transactionHash };
}
export function parseGrantAmount(input: string): bigint {
  check(/^(0|[1-9][0-9]{0,59})(?:\.[0-9]{1,18})?$/.test(input), "INVALID_AMOUNT");
  const [whole, fraction = ""] = input.split(".");
  const value = BigInt(whole) * BigInt(10) ** BigInt(18) + BigInt(fraction.padEnd(18, "0"));
  uintWord(value); return value;
}
// keccak256 of L05 spend(address,bytes32,uint256), checked against ethers/compiled ABI in tests.
export function encodeGrantSpend(config: GrantConfig, amount: bigint) {
  check(hash(config.category), "INVALID_DEPLOYMENT");
  return `0xe2f7cbfa${word(config.merchant)}${config.category.slice(2)}${uintWord(amount)}`;
}
export type GrantEvent = { event: "GrantSpent"; transactionHash: string; blockNumber: number; blockHash: string; logIndex: number;
  beneficiary: string; merchant: string; category: string; amountWei: string; balanceWei: string };
export type GrantLookup = { balanceWei: string; block: { number: number; hash: string }; allowed: boolean;
  transaction: null | { hash: string; status: "pending" | "verified"; event: GrantEvent | null } };
export type GrantIntent = { schemaVersion: 1; id: string; chainId: 20261; beneficiary: string; vault: string; deploymentHash: string;
  merchant: string; category: string; amountWei: string; afterBlock: number; recoveredHash: boolean;
  phase: "unknown" | "pending" | "confirmed" | "reverted"; hash: string | null };

/** B05 remains the chain/receipt verifier; this parser binds its trusted response to this exact wallet and spend. */
export function parseGrantLookup(value: unknown, config: GrantConfig, beneficiary: string, intent?: GrantIntent | null): GrantLookup {
  const data = object(value), category = object(data.category), block = object(data.block);
  check(data.schemaVersion === 1 && data.status === "verified" && data.chainId === 20261
    && same(data.beneficiary, beneficiary) && same(data.vaultAddress, config.vault)
    && same(category.id, config.category) && category.label === "FOOD" && money(data.balanceWei)
    && integer(block.number) && hash(block.hash));
  check(Array.isArray(data.allowedMerchants) && data.allowedMerchants.length === 1);
  const merchant = object(data.allowedMerchants[0]);
  check(merchant.id === "canteen" && same(merchant.address, config.merchant) && typeof merchant.allowed === "boolean");
  let transaction: GrantLookup["transaction"] = null;
  if (intent?.hash) {
    const tx = object(data.transaction);
    check(same(tx.hash, intent.hash) && ["pending", "verified"].includes(String(tx.status)) && Array.isArray(tx.events));
    if (tx.status === "pending") { check(tx.events.length === 0); transaction = { hash: intent.hash, status: "pending", event: null }; }
    else {
      check(tx.events.length === 1);
      const event = object(tx.events[0]);
      check(event.event === "GrantSpent" && same(event.transactionHash, intent.hash) && integer(event.blockNumber)
        && event.blockNumber > intent.afterBlock && event.blockNumber <= Number(block.number) && hash(event.blockHash) && integer(event.logIndex)
        && same(event.beneficiary, beneficiary) && same(event.merchant, intent.merchant)
        && same(event.category, intent.category) && money(event.amountWei) && event.amountWei === intent.amountWei
        && money(event.balanceWei));
      transaction = { hash: intent.hash, status: "verified", event: event as GrantEvent };
    }
  } else check(data.transaction === null);
  return { balanceWei: data.balanceWei, block: { number: block.number, hash: block.hash }, allowed: merchant.allowed, transaction };
}
export async function lookupGrant(fetcher: typeof fetch, config: GrantConfig, beneficiary: string, intent?: GrantIntent | null, signal?: AbortSignal): Promise<GrantLookup> {
  check(isWalletAddress(beneficiary), "INVALID_ACCOUNT");
  let response: Response, data: unknown;
  try {
    response = await fetcher(`/api/grants/${beneficiary}${intent?.hash ? `?txHash=${intent.hash}` : ""}`, {
      cache: "no-store", redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
    });
    const reader = response.body?.getReader(); check(reader, "RPC_UNAVAILABLE");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; check(size <= 256 * 1024); chunks.push(next.value); }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) { if (error instanceof GrantUiError) throw error; throw new GrantUiError("RPC_UNAVAILABLE"); }
  if (!response.ok) {
    const body = object(data), error = object(body.error);
    check(body.status === "unverified" && body.chainId === 20261 && body.balanceWei === null && typeof error.retryable === "boolean");
    const known = ["TX_REVERTED", "RECEIPT_MISMATCH", "DEPLOYMENT_NOT_CONFIGURED", "INVALID_DEPLOYMENT", "DEPLOYMENT_MISMATCH", "WRONG_CHAIN", "RPC_UNAVAILABLE", "CHAIN_CHANGED"];
    check(known.includes(String(error.code)) && (response.status === 422 ? ["TX_REVERTED", "RECEIPT_MISMATCH"].includes(String(error.code)) : response.status === 503));
    throw new GrantUiError(String(error.code));
  }
  return parseGrantLookup(data, config, beneficiary, intent);
}

/** A pinned read for display is followed by a latest-state simulation immediately before opening Core. */
export async function preflightGrant(rpc: WalletRpc, config: GrantConfig, beneficiary: string, amount: bigint, signal?: AbortSignal) {
  check(isWalletAddress(beneficiary) && !same(beneficiary, config.merchant), "INVALID_ACCOUNT"); uintWord(amount);
  check(quantity(await rpc("eth_chainId", [], signal)) === BigInt(20261), "WRONG_CHAIN");
  const block = object(await rpc("eth_getBlockByNumber", ["latest", false], signal));
  quantity(block.number); check(hash(block.hash), "RPC_UNAVAILABLE");
  const call = (to: string, data: string, tag: unknown = block.number) => rpc("eth_call", [{ to, data }, tag], signal);
  const [balance, allowed, registry, issuer] = await Promise.all([
    call(config.vault, `0x1f14df69${word(beneficiary)}${config.category.slice(2)}`),
    call(config.registry, `0x6f790f46${word(config.merchant)}${config.category.slice(2)}`),
    call(config.vault, "0x6eca5042"), call(config.vault, "0x1d143848"),
  ]);
  check(rpcUint(balance) >= amount, "INSUFFICIENT_GRANT_BALANCE");
  check(rpcUint(allowed) === BigInt(1), "MERCHANT_NOT_ALLOWED");
  check(typeof registry === "string" && registry.toLowerCase() === `0x${word(config.registry)}`
    && typeof issuer === "string" && issuer.toLowerCase() === `0x${word(config.issuer)}`, "DEPLOYMENT_MISMATCH");
  const transaction = { from: beneficiary, to: config.vault, data: encodeGrantSpend(config, amount), value: "0x0" };
  try { check(await rpc("eth_call", [transaction, "latest"], signal) === "0x", "SIMULATION_FAILED"); }
  catch { throw new GrantUiError("SIMULATION_FAILED"); }
  const canonical = object(await rpc("eth_getBlockByNumber", [block.number, false], signal));
  check(same(canonical.hash, String(block.hash)) && quantity(await rpc("eth_chainId", [], signal)) === BigInt(20261), "CHAIN_CHANGED");
  const afterBlock = Number(quantity(block.number)); check(integer(afterBlock), "RPC_UNAVAILABLE");
  return { transaction, afterBlock };
}

export function grantMessage(code: string): string {
  const messages: Record<string, string> = {
    DEPLOYMENT_NOT_CONFIGURED: "Chưa có bản triển khai học bổng. Nhờ nhóm hoàn tất L06 trước khi chi.",
    INVALID_DEPLOYMENT: "Cấu hình học bổng chưa được xác minh. Nhờ nhóm kiểm tra L06.",
    DEPLOYMENT_MISMATCH: "Vault hoặc cấu hình không khớp bản triển khai. Chưa thể chi.",
    INVALID_GRANT_RESPONSE: "Dữ liệu học bổng hoặc biên nhận chưa khớp. Giữ hash và thử tra cứu lại.",
    INVALID_AMOUNT: "Nhập số CAMPUS lớn hơn 0, tối đa 18 chữ số thập phân; dùng dấu chấm cho phần lẻ.",
    INSUFFICIENT_GRANT_BALANCE: "Số tiền vượt ngân sách FOOD hiện tại. Đọc lại số dư hoặc giảm khoản chi.",
    MERCHANT_NOT_ALLOWED: "Căn-tin không còn được phép nhận FOOD. Chưa gửi giao dịch, số dư voucher giữ nguyên.",
    WRONG_CHAIN: "Chuyển ví về IntraCampus L1, chain 20261, rồi thử đọc lại.",
    CHAIN_CHANGED: "Mạng thay đổi trong lúc kiểm tra. Đọc lại trước khi tiếp tục.",
    INVALID_ACCOUNT: "Kết nối đúng ví được cấp học bổng trước khi chi.",
    SIMULATION_FAILED: "Chưa mô phỏng được khoản chi. Kiểm tra số dư, merchant và kết nối; chưa mở yêu cầu ký.",
    SIGNATURE_REJECTED: "Bạn đã từ chối ký. Chưa gửi khoản chi; có thể xem lại và thử lại.",
    SEND_OUTCOME_UNKNOWN: "Chưa rõ ví đã gửi hay chưa. Kiểm tra lịch sử Core và tra hash; không gửi lại khoản chi.",
    TX_REVERTED: "Giao dịch đã thất bại. Voucher không bị trừ; ví vẫn có thể mất phí gas.",
    RECEIPT_MISMATCH: "Receipt chưa khớp khoản chi này. Giữ hash để đối chiếu, chưa xác nhận thành công.",
    STORAGE_UNAVAILABLE: "Trình duyệt không lưu được giao dịch để khôi phục. Cho phép lưu trữ trước khi chi.",
    JOURNAL_INVALID: "Bản ghi khoản chi chưa rõ kết quả hoặc không hợp lệ. Kiểm tra lịch sử Core; không xóa dữ liệu để chi lại.",
    LOCK_UNAVAILABLE: "Phiên này chưa hỗ trợ khóa giao dịch giữa các tab. Mở trang HTTPS trong Core hoặc Chromium có Web Locks.",
    SPEND_IN_PROGRESS: "Khoản chi trước đang chờ hoặc chưa rõ kết quả. Tra giao dịch đó trước khi tạo khoản mới.",
    RECOVERY_HASH_REVERTED: "Hash nhập vào đã revert nhưng chưa đủ để xác định khoản chi bị mất hash. Kiểm tra đúng giao dịch trong Core; vẫn chặn chi lại.",
    WALLET_CHANGED: "Tài khoản hoặc mạng đã thay đổi. Kiểm tra lại trước khi ký.",
  };
  return messages[code] ?? "Chưa đọc được dữ liệu học bổng. Kiểm tra kết nối và thử lại; giữ hash nếu đã gửi.";
}

export type GrantSender = { getSnapshot(): { address: string | null; chainId: bigint | null; canProceed: boolean };
  sendTransaction(account: string, tx: { to: string; data: string; value: string }): Promise<string> };
export type GrantState = { beneficiary: string | null; lookup: GrantLookup | null; stale: boolean; busy: boolean;
  phase: "idle" | "checking" | "signing" | "unknown" | "pending" | "confirmed" | "reverted"; intent: GrantIntent | null;
  message: string | null; errorCode: string | null; storageBlocked: boolean };
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Lock = (name: string, run: () => Promise<void>) => Promise<void>;
export const grantJournalKey = (config: GrantConfig, beneficiary: string) => `intracampus.grant.spend.v1:20261:${config.deploymentHash.toLowerCase()}:${beneficiary.toLowerCase()}`;
export const browserGrantLock: Lock = async (name, run) => {
  if (typeof navigator === "undefined" || !navigator.locks) throw new GrantUiError("LOCK_UNAVAILABLE");
  await navigator.locks.request(name, { ifAvailable: true }, async (lock) => { check(lock, "SPEND_IN_PROGRESS"); await run(); });
};

export class GrantController {
  private state: GrantState = { beneficiary: null, lookup: null, stale: false, busy: false, phase: "idle", intent: null, message: null, errorCode: null, storageBlocked: false };
  private listeners = new Set<() => void>(); private generation = 0; private disposed = false; private operation = false;
  private timer: ReturnType<typeof setTimeout> | undefined; private abort?: AbortController;
  private options: { config: GrantConfig; rpc: WalletRpc; wallet: GrantSender; storage: Store; fetcher?: typeof fetch; lock?: Lock; pollMs?: number };
  constructor(options: GrantController["options"]) { this.options = options; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(value: Partial<GrantState>) { if (this.disposed) return; this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener(); }
  private active(generation: number) { return !this.disposed && this.generation === generation; }
  private fail(error: unknown) { const code = error instanceof GrantUiError ? error.code : "RPC_UNAVAILABLE"; this.set({ message: grantMessage(code), errorCode: code, stale: this.state.lookup !== null }); }
  private readIntent(account: string): GrantIntent | null {
    let raw: string | null; try { raw = this.options.storage.getItem(grantJournalKey(this.options.config, account)); }
    catch { throw new GrantUiError("STORAGE_UNAVAILABLE"); }
    if (raw === null) return null;
    try {
      const data = object(JSON.parse(raw)), c = this.options.config;
      check(data.schemaVersion === 1 && typeof data.id === "string" && /^[0-9a-f-]{36}$/i.test(data.id)
        && data.chainId === 20261 && same(data.beneficiary, account) && same(data.vault, c.vault)
        && same(data.deploymentHash, c.deploymentHash) && same(data.merchant, c.merchant) && same(data.category, c.category)
        && money(data.amountWei) && BigInt(data.amountWei) > BigInt(0) && integer(data.afterBlock) && typeof data.recoveredHash === "boolean"
        && ["unknown", "pending", "confirmed", "reverted"].includes(String(data.phase))
        && (data.phase === "unknown" ? data.hash === null : hash(data.hash)), "JOURNAL_INVALID");
      return data as GrantIntent;
    } catch { throw new GrantUiError("JOURNAL_INVALID"); }
  }
  private write(account: string, intent: GrantIntent | null) {
    try { const key = grantJournalKey(this.options.config, account); if (intent) this.options.storage.setItem(key, JSON.stringify(intent)); else this.options.storage.removeItem(key); }
    catch { throw new GrantUiError("STORAGE_UNAVAILABLE"); }
  }
  private walletMatches(account: string) {
    const wallet = this.options.wallet.getSnapshot();
    check(same(wallet.address, account) && wallet.chainId === BigInt(20261) && wallet.canProceed, "WALLET_CHANGED");
  }
  private async settle(account: string, intent: GrantIntent) {
    await (this.options.lock ?? browserGrantLock)(grantJournalKey(this.options.config, account), async () => {
      const latest = this.readIntent(account);
      check(latest?.id === intent.id && (latest.hash === intent.hash || (latest.phase === "unknown" && latest.hash === null)), "SPEND_IN_PROGRESS");
      this.write(account, intent);
    });
  }
  async bindWallet(account: string | null) {
    this.generation++; this.abort?.abort(); clearTimeout(this.timer); this.timer = undefined;
    this.set({ beneficiary: account, lookup: null, intent: null, phase: "idle", message: null, errorCode: null, stale: false, busy: false, storageBlocked: false });
    if (!account) return;
    if (!isWalletAddress(account)) { this.fail(new GrantUiError("INVALID_ACCOUNT")); return; }
    try { const intent = this.readIntent(account); this.set({ intent, phase: intent?.phase ?? "idle" }); }
    catch (error) { this.set({ storageBlocked: true }); this.fail(error); }
    await this.refresh();
  }
  async refresh() {
    const account = this.state.beneficiary; if (!account || this.state.busy || this.disposed) return;
    clearTimeout(this.timer); this.timer = undefined; const generation = this.generation;
    this.abort?.abort(); this.abort = new AbortController(); this.set({ busy: true });
    try {
      if (!this.state.storageBlocked) {
        const intent = this.readIntent(account); this.set({ intent, phase: intent?.phase ?? "idle" });
      }
      const result = await lookupGrant(this.options.fetcher ?? fetch, this.options.config, account, this.state.intent, this.abort.signal);
      if (!this.active(generation)) return;
      let intent = this.state.intent;
      if (intent?.hash && result.transaction?.status === "verified") {
        intent = { ...intent, phase: "confirmed" }; await this.settle(account, intent);
      }
      if (!this.active(generation)) return;
      this.set({ lookup: result, stale: false, intent, phase: intent?.phase ?? "idle", errorCode: null,
        message: intent?.phase === "confirmed" ? "Đã xác minh khoản chi FOOD. Số dư hiển thị đã đọc lại từ chain."
          : intent?.phase === "unknown" ? grantMessage("SEND_OUTCOME_UNKNOWN") : null });
    } catch (error) {
      if (!this.active(generation)) return;
      if (error instanceof GrantUiError && error.code === "TX_REVERTED" && this.state.intent?.hash) {
        if (this.state.intent.recoveredHash) { this.fail(new GrantUiError("RECOVERY_HASH_REVERTED")); return; }
        const intent: GrantIntent = { ...this.state.intent, phase: "reverted" };
        try { await this.settle(account, intent); if (this.active(generation)) this.set({ intent, phase: "reverted" }); }
        catch (saveError) { if (this.active(generation)) { this.set({ storageBlocked: true }); this.fail(saveError); } return; }
      }
      if (this.active(generation)) this.fail(error);
    } finally {
      if (this.active(generation)) {
        this.set({ busy: false });
        if (this.state.intent?.phase === "pending" && !["RECOVERY_HASH_REVERTED", "RECEIPT_MISMATCH", "INVALID_GRANT_RESPONSE"].includes(this.state.errorCode ?? "")) {
          this.timer = setTimeout(() => { void this.refresh(); }, this.options.pollMs ?? 2500);
        }
      }
    }
  }
  async spend(amount: bigint) {
    if (this.operation || this.state.busy || this.disposed) return;
    const account = this.state.beneficiary, generation = this.generation;
    if (!account) { this.fail(new GrantUiError("INVALID_ACCOUNT")); return; }
    this.operation = true; this.set({ busy: true, phase: "checking", message: null, errorCode: null });
    try {
      await (this.options.lock ?? browserGrantLock)(grantJournalKey(this.options.config, account), async () => {
        check(!this.state.storageBlocked, "STORAGE_UNAVAILABLE");
        check(this.readIntent(account) === null, "SPEND_IN_PROGRESS"); this.walletMatches(account);
        const lookup = await lookupGrant(this.options.fetcher ?? fetch, this.options.config, account);
        check(lookup.allowed, "MERCHANT_NOT_ALLOWED"); check(BigInt(lookup.balanceWei) >= amount, "INSUFFICIENT_GRANT_BALANCE");
        check(this.active(generation), "WALLET_CHANGED");
        const { transaction, afterBlock } = await preflightGrant(this.options.rpc, this.options.config, account, amount);
        check(this.active(generation), "WALLET_CHANGED"); this.walletMatches(account);
        const c = this.options.config;
        let intent: GrantIntent = { schemaVersion: 1, id: crypto.randomUUID(), chainId: 20261, beneficiary: account, vault: c.vault, deploymentHash: c.deploymentHash,
          merchant: c.merchant, category: c.category, amountWei: amount.toString(), afterBlock, recoveredHash: false, phase: "unknown", hash: null };
        this.write(account, intent); this.set({ intent, phase: "signing", lookup, stale: false });
        let txHash: string;
        try { txHash = await this.options.wallet.sendTransaction(account, transaction); check(hash(txHash), "SEND_OUTCOME_UNKNOWN"); }
        catch (error) {
          const outcome = error && typeof error === "object" && "outcome" in error ? error.outcome : "unknown";
          if (outcome === "not-sent" || outcome === "rejected") { this.write(account, null); if (this.active(generation)) this.set({ intent: null, phase: "idle" });
            throw new GrantUiError(outcome === "rejected" ? "SIGNATURE_REJECTED" : "WALLET_CHANGED"); }
          if (this.active(generation)) this.set({ phase: "unknown" }); throw new GrantUiError("SEND_OUTCOME_UNKNOWN");
        }
        intent = { ...intent, hash: txHash, phase: "pending" };
        try { this.write(account, intent); }
        catch {
          // The unknown intent was saved before send. Keep the returned hash visible even when the second write fails.
          if (this.active(generation)) this.set({ intent, phase: "pending", storageBlocked: true });
          throw new GrantUiError("STORAGE_UNAVAILABLE");
        }
        if (this.active(generation)) this.set({ intent, phase: "pending", message: "Đã gửi. Đang đối chiếu receipt và GrantSpent…" });
      });
    } catch (error) { if (this.active(generation)) { if (this.state.phase === "checking") this.set({ phase: this.state.intent?.phase ?? "idle" }); this.fail(error); } }
    finally {
      this.operation = false;
      if (this.active(generation)) { this.set({ busy: false }); if (this.state.intent?.hash) await this.refresh(); }
    }
  }
  async recoverHash(value: string) {
    const account = this.state.beneficiary, intent = this.state.intent;
    const canCorrect = intent?.recoveredHash && ["RECOVERY_HASH_REVERTED", "RECEIPT_MISMATCH", "INVALID_GRANT_RESPONSE"].includes(this.state.errorCode ?? "");
    if (!account || !intent || (intent.phase !== "unknown" && !canCorrect) || this.state.busy || this.operation) return;
    try {
      check(hash(value), "INVALID_GRANT_RESPONSE");
      await (this.options.lock ?? browserGrantLock)(grantJournalKey(this.options.config, account), async () => {
        const latest = this.readIntent(account); check(latest?.id === intent.id && (latest.phase === "unknown" || (latest.phase === "pending" && latest.recoveredHash && canCorrect)), "SPEND_IN_PROGRESS");
        const next: GrantIntent = { ...intent, hash: value, recoveredHash: true, phase: "pending" };
        this.write(account, next); this.set({ intent: next, phase: "pending" });
      });
      await this.refresh();
    }
    catch (error) { this.fail(error); }
  }
  async newSpend() {
    const account = this.state.beneficiary;
    if (!account || this.operation || this.state.busy || !["confirmed", "reverted"].includes(this.state.phase)) return;
    try {
      await (this.options.lock ?? browserGrantLock)(grantJournalKey(this.options.config, account), async () => {
        const intent = this.readIntent(account); check(intent && ["confirmed", "reverted"].includes(intent.phase), "SPEND_IN_PROGRESS");
        this.write(account, null); this.set({ intent: null, phase: "idle", message: null, errorCode: null, storageBlocked: false });
      });
      await this.refresh();
    } catch (error) { this.fail(error); }
  }
  dispose() { this.disposed = true; this.generation++; this.abort?.abort(); clearTimeout(this.timer); this.listeners.clear(); }
}
