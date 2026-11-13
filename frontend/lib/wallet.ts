import { campusNetwork, campusChainHex, isWalletAddress, validateWalletConfig, walletChainParameters, type WalletConfig } from "./chains.ts";

export interface WalletProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}
export type WalletRpc = (method: string, params: unknown[], signal?: AbortSignal) => Promise<unknown>;
export type WalletTransaction = { to: string; data: string; value: string };
export class WalletTransactionError extends Error {
  readonly code: string;
  readonly outcome: "not-sent" | "rejected" | "unknown";
  constructor(code: string, outcome: "not-sent" | "rejected" | "unknown") {
    super(code); this.name = "WalletTransactionError"; this.code = code; this.outcome = outcome;
  }
}
export type WalletStatus = "initializing" | "no-wallet" | "disconnected" | "connecting" | "rejected"
  | "wrong-chain" | "loading" | "ready" | "rpc-error" | "config-missing";
export type StudentCard = { status: "unknown" | "none" | "valid" | "expired" | "inactive";
  tier: 0 | 1 | null; tokenId: bigint | null; expiresAt: bigint | null };
export type WalletSnapshot = {
  status: WalletStatus; address: string | null; accounts: string[]; chainId: bigint | null;
  balanceWei: bigint | null; card: StudentCard; blockTimestamp: bigint | null;
  canProceed: boolean; message: string | null;
};
const unknownCard = (): StudentCard => ({ status: "unknown", tier: null, tokenId: null, expiresAt: null });
const initial = (): WalletSnapshot => ({ status: "initializing", address: null, accounts: [], chainId: null,
  balanceWei: null, card: unknownCard(), blockTimestamp: null, canProceed: false, message: null });
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value)) throw new Error("INVALID_RPC_DATA");
  return BigInt(value);
}
function accounts(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(isWalletAddress)) throw new Error("INVALID_WALLET_ACCOUNTS");
  return [...new Set(value.map((a: string) => a.toLowerCase()))];
}
function errorCode(error: unknown): number | undefined {
  return error && typeof error === "object" && "code" in error ? Number(error.code) : undefined;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_RPC_DATA");
  return value as Record<string, unknown>;
}
export function createWalletRpc(url: string): WalletRpc {
  let nextId = 0;
  return async (method, params, signal) => {
    const id = ++nextId;
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]) });
    if (!response.ok || !response.body) throw new Error("RPC_UNAVAILABLE");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.length; if (bytes > 256 * 1024) throw new Error("RPC_RESPONSE_TOO_LARGE");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const data = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    const body = record(JSON.parse(new TextDecoder().decode(data)));
    if (body.jsonrpc !== "2.0" || body.id !== id || body.error || !Object.hasOwn(body, "result")) throw new Error("RPC_UNAVAILABLE");
    return body.result;
  };
}

export class WalletController {
  private provider?: WalletProvider;
  private config: WalletConfig;
  private rpc?: WalletRpc;
  private invalidConfig = false;
  private state = initial();
  private listeners = new Set<() => void>();
  private generation = 0;
  private stopped = false;
  private attached = false;
  private busy = false;
  private sending = false;
  private locallyDisconnected = false;
  private abort?: AbortController;
  private readonly accountEvent = (value: unknown) => {
    if (this.locallyDisconnected) return;
    try { void this.refresh(accounts(value)); }
    catch { this.invalidate(); this.set({ ...initial(), status: "rpc-error", message: "Ví trả về tài khoản không hợp lệ." }); }
  };
  private readonly chainEvent = () => { if (!this.locallyDisconnected) void this.refresh(); };
  private readonly disconnectEvent = () => this.disconnect();
  constructor(options: { provider?: WalletProvider; config: WalletConfig; rpc?: WalletRpc }) {
    this.provider = options.provider;
    try { this.config = validateWalletConfig(options.config); }
    catch { this.config = {}; this.invalidConfig = true; }
    this.rpc = options.rpc ?? (this.config.rpcUrl ? createWalletRpc(this.config.rpcUrl) : undefined);
  }
  getSnapshot = (): WalletSnapshot => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(next: WalletSnapshot) {
    if (this.stopped) return;
    this.state = next; for (const listener of this.listeners) listener();
  }
  private invalidate() { this.abort?.abort(); this.abort = new AbortController(); return ++this.generation; }
  private current(generation: number) { return !this.stopped && generation === this.generation; }
  private attach() {
    if (!this.provider || this.attached) return;
    this.provider.on("accountsChanged", this.accountEvent);
    this.provider.on("chainChanged", this.chainEvent);
    this.provider.on("disconnect", this.disconnectEvent);
    this.attached = true;
  }
  async start() { if (this.stopped) return; this.attach(); await this.refresh(); }
  async connect() {
    if (this.stopped || this.busy) return;
    if (!this.provider) { this.set({ ...initial(), status: "no-wallet" }); return; }
    this.locallyDisconnected = false;
    this.attach(); this.busy = true;
    const generation = this.invalidate(); this.set({ ...initial(), status: "connecting" });
    try {
      const permitted = accounts(await this.provider.request({ method: "eth_requestAccounts" }));
      if (this.current(generation)) await this.refresh(permitted);
    } catch (error) {
      if (this.current(generation)) this.set({ ...initial(), status: errorCode(error) === 4001 ? "rejected" : "rpc-error",
        message: errorCode(error) === -32002 ? "Ví đang có yêu cầu chờ xác nhận. Hãy mở ví để tiếp tục." : "Chưa kết nối được ví. Bạn có thể thử lại." });
    } finally { this.busy = false; }
  }
  async refresh(knownAccounts?: string[], selected?: string) {
    if (this.stopped || this.locallyDisconnected) return;
    const generation = this.invalidate();
    if (!this.provider) { this.set({ ...initial(), status: "no-wallet" }); return; }
    const previous = selected ?? (knownAccounts ? undefined : this.state.address);
    // A periodic read must not unmount a payment popup/recovery panel for the same account.
    // Monetary data/readiness are still invalidated immediately, before any provider await.
    this.set({ ...this.state, status: "loading", balanceWei: null, card: unknownCard(), blockTimestamp: null, canProceed: false, message: null });
    try {
      const [available, rawChain] = await Promise.all([
        knownAccounts ?? this.provider.request({ method: "eth_accounts" }).then(accounts),
        this.provider.request({ method: "eth_chainId" }),
      ]);
      if (!this.current(generation)) return;
      const chainId = quantity(rawChain);
      const address = previous && available.includes(previous) ? previous : available[0];
      if (!address) { this.set({ ...initial(), status: "disconnected", chainId }); return; }
      const base = { ...initial(), status: "loading" as WalletStatus, address, accounts: available, chainId };
      this.set(base);
      if (chainId !== BigInt(campusNetwork.chainId)) { this.set({ ...base, status: "wrong-chain" }); return; }
      if (this.invalidConfig || !this.config.rpcUrl || !this.rpc) {
        this.set({ ...base, status: "config-missing", message: "Chưa có cấu hình RPC tin cậy để đọc ví." }); return;
      }
      const signal = this.abort!.signal;
      const call: WalletRpc = (method, params) => this.rpc!(method, params, signal);
      if (quantity(await call("eth_chainId", [])) !== BigInt(campusNetwork.chainId)) throw new Error("RPC_WRONG_CHAIN");
      const block = record(await call("eth_getBlockByNumber", ["latest", false]));
      quantity(block.number); const timestamp = quantity(block.timestamp);
      const balanceWei = quantity(await call("eth_getBalance", [address, block.number]));
      if (!this.current(generation)) return;
      const withBalance = { ...base, balanceWei, blockTimestamp: timestamp }; this.set(withBalance);
      if (!this.config.sbtAddress) {
        this.set({ ...withBalance, status: "config-missing", message: "Chưa có địa chỉ thẻ sinh viên đã được cấu hình; ưu đãi chưa xác minh." }); return;
      }
      const encodedAddress = address.slice(2).padStart(64, "0");
      const [tierResult, credentialsResult] = await Promise.all([
        call("eth_call", [{ to: this.config.sbtAddress, data: `0xc8f74bb8${encodedAddress}` }, block.number]),
        call("eth_call", [{ to: this.config.sbtAddress, data: `0x6016dd4a${encodedAddress}` }, block.number]),
      ]);
      if (typeof tierResult !== "string" || !/^0x[0-9a-f]{64}$/i.test(tierResult)
        || typeof credentialsResult !== "string" || !/^0x[0-9a-f]{128}$/i.test(credentialsResult)) throw new Error("INVALID_SBT_DATA");
      const tierValue = BigInt(tierResult);
      const tokenId = BigInt(`0x${credentialsResult.slice(2, 66)}`), expiresAt = BigInt(`0x${credentialsResult.slice(66)}`);
      if ((tierValue !== BigInt(0) && tierValue !== BigInt(1)) || expiresAt >= BigInt(2) ** BigInt(64)
        || (tokenId === BigInt(0) && (expiresAt !== BigInt(0) || tierValue !== BigInt(0)))
        || (tierValue === BigInt(1) && timestamp > expiresAt)) throw new Error("INVALID_SBT_DATA");
      const card: StudentCard = { tier: Number(tierValue) as 0 | 1, tokenId, expiresAt,
        status: tokenId === BigInt(0) ? "none" : timestamp > expiresAt ? "expired" : tierValue === BigInt(1) ? "valid" : "inactive" };
      if (this.current(generation)) this.set({ ...withBalance, status: "ready", card, canProceed: true });
    } catch {
      if (this.current(generation)) this.set({ ...this.state, status: "rpc-error", card: unknownCard(), canProceed: false,
        message: "Không xác minh được dữ liệu trên IntraCampus L1. Kiểm tra kết nối và thử lại." });
    }
  }
  async selectAccount(address: string) {
    if (this.state.accounts.includes(address)) await this.refresh(this.state.accounts, address);
  }
  /** The connected student signs. A returned hash survives account changes while Core is open. */
  async sendTransaction(expectedAccount: string, transaction: WalletTransaction): Promise<string> {
    const fail = (code: string): never => { throw new WalletTransactionError(code, "not-sent"); };
    if (this.sending) fail("WALLET_REQUEST_PENDING");
    if (!isWalletAddress(expectedAccount) || !isWalletAddress(transaction.to)
      || !/^0x(?:[0-9a-f]{2})+$/i.test(transaction.data)
      || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(transaction.value)) fail("INVALID_TRANSACTION");
    const selected = () => !this.stopped && !this.locallyDisconnected && this.state.canProceed
      && this.state.address?.toLowerCase() === expectedAccount.toLowerCase()
      && this.state.chainId === BigInt(campusNetwork.chainId);
    if (!this.provider || !selected()) fail("WALLET_SESSION_CHANGED");
    this.sending = true;
    let requested = false;
    try {
      const [available, chain] = await Promise.all([
        this.provider!.request({ method: "eth_accounts" }).then(accounts),
        this.provider!.request({ method: "eth_chainId" }).then(quantity),
      ]);
      if (chain !== BigInt(campusNetwork.chainId)) fail("WRONG_CHAIN");
      if (!selected() || !available.includes(expectedAccount.toLowerCase())) fail("WALLET_SESSION_CHANGED");
      requested = true;
      const hash = await this.provider!.request({ method: "eth_sendTransaction", params: [{
        from: expectedAccount, to: transaction.to, data: transaction.data, value: transaction.value,
        chainId: campusChainHex,
      }] });
      if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(hash) || /^0x0{64}$/i.test(hash)) {
        throw new WalletTransactionError("SEND_OUTCOME_UNKNOWN", "unknown");
      }
      return hash;
    } catch (error) {
      if (error instanceof WalletTransactionError) throw error;
      if (requested && errorCode(error) === 4001) throw new WalletTransactionError("SIGNATURE_REJECTED", "rejected");
      throw new WalletTransactionError(requested ? "SEND_OUTCOME_UNKNOWN" : "WALLET_UNAVAILABLE", requested ? "unknown" : "not-sent");
    } finally { this.sending = false; }
  }
  async switchNetwork() {
    if (!this.provider || this.stopped || this.busy) return;
    this.busy = true;
    const generation = this.invalidate();
    this.set({ ...this.state, status: "loading", balanceWei: null, card: unknownCard(), canProceed: false, message: null });
    try {
      try { await this.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: campusChainHex }] }); }
      catch (error) {
        if (errorCode(error) !== 4902) throw error;
        if (!this.current(generation)) return;
        await this.provider.request({ method: "wallet_addEthereumChain", params: [walletChainParameters(this.config)] });
        if (!this.current(generation)) return;
        await this.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: campusChainHex }] });
      }
      if (this.current(generation)) await this.refresh();
    } catch (error) {
      if (!this.current(generation)) return;
      const refresh = this.refresh();
      const refreshGeneration = this.generation;
      await refresh;
      if (this.current(refreshGeneration)) this.set({ ...this.state, message: errorCode(error) === 4001
        ? "Bạn đã từ chối chuyển mạng. Chuyển sang IntraCampus L1 khi sẵn sàng."
        : "Chưa chuyển được mạng. Kiểm tra cấu hình RPC và thử lại." });
    } finally { this.busy = false; }
  }
  disconnect() { this.locallyDisconnected = true; this.invalidate(); this.set({ ...initial(), status: "disconnected" }); }
  dispose() {
    this.invalidate(); this.stopped = true;
    if (this.provider && this.attached) {
      this.provider.removeListener("accountsChanged", this.accountEvent);
      this.provider.removeListener("chainChanged", this.chainEvent);
      this.provider.removeListener("disconnect", this.disconnectEvent);
    }
    this.attached = false; this.listeners.clear();
  }
}
