import { getAddress, hexlify, toUtf8Bytes, Interface, keccak256 } from "ethers";
import { CLOUD_CAMPUS_CHAIN_ID, requireDeployment, resolveCampusChainId, type CampusChainId, type CampusPayout } from "@intracampus/network";
import { AuthService } from "../auth/auth.service.ts";
import { readLibraryAuthConfig, type LibraryAuthConfig } from "../auth/auth.config.ts";
import { HttpInvoiceRpc, type InvoiceRpc } from "../invoices/invoices.rpc.ts";
import { isFreshInvoiceChainTimestamp, defaultInvoiceChainFreshness } from "../invoices/chain-freshness.ts";
import { CampusError, CampusRepository } from "./campus.repository.ts";
import { NativeMinterError, NativeMinterService, NATIVE_MINTER_ADDRESS, WELCOME_MINT_WEI } from "../native-minter/native-minter.service.ts";

export const welcomeWei = 20n * 10n ** 18n;
const grantAbi = new Interface(["function issuer() view returns(address)", "function grant(address,bytes32) payable", "event GrantIssued(address indexed beneficiary,bytes32 indexed category,address indexed issuer,uint256 amount,uint256 balance)"]);
const nativeMinterAbi = new Interface(["function mintNativeCoin(address addr,uint256 amount)"]);
function address(value: string) { const result = getAddress(value).toLowerCase(); if (/^0x0{40}$/.test(result)) throw Error("Invalid address"); return result; }
function hex(value: unknown): bigint { if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new CampusError("RPC_UNAVAILABLE", 503); return BigInt(value); }
function object(value: unknown): Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new CampusError("RPC_UNAVAILABLE", 503); return value as Record<string, any>; }
export class CampusService {
  auth: AuthService;
  authConfig: LibraryAuthConfig;
  schools: Set<string>;
  readonly chainId: CampusChainId;
  private rpc: InvoiceRpc;
  private treasury?: string;
  private scholarshipWei: bigint;
  private resolveOverrides?: () => { welcomeTreasury?: string | null; scholarshipWei?: string | null };
  repository: CampusRepository;
  private env: Record<string, string | undefined>;
  private deployment?: unknown;
  private nativeMinter?: NativeMinterService;
  constructor(repository: CampusRepository, env: Record<string, string | undefined>, rpc?: InvoiceRpc, deployment?: unknown,
    resolveOverrides?: () => { welcomeTreasury?: string | null; scholarshipWei?: string | null }, nativeMinter?: NativeMinterService) {
    this.repository = repository; this.env = env; this.deployment = deployment;
    this.resolveOverrides = resolveOverrides;
    this.nativeMinter = nativeMinter;
    this.chainId = resolveCampusChainId(env.NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID);
    this.authConfig = { ...readLibraryAuthConfig({ ...env,
      LIBRARY_AUTH_ORIGIN: env.CAMPUS_AUTH_ORIGIN ?? env.LIBRARY_AUTH_ORIGIN,
      LIBRARY_CHALLENGE_TTL_SECONDS: "300", LIBRARY_SESSION_TTL_SECONDS: "3600",
      LIBRARY_CHALLENGE_RATE_LIMIT_MAX_REQUESTS: "10", LIBRARY_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS: "60",
      LIBRARY_VERIFY_RATE_LIMIT_MAX_REQUESTS: "20", LIBRARY_VERIFY_RATE_LIMIT_WINDOW_SECONDS: "60",
    }), chainId: this.chainId, statement: "Sign in to IntraCampus. Signing does not verify student status or transfer funds." };
    this.authConfig.cookieName = this.authConfig.secureCookie ? "__Host-campus_session" : "campus_session";
    this.auth = new AuthService(repository, this.authConfig);
    this.schools = new Set((env.CAMPUS_SCHOOL_WALLETS ?? "").split(",").filter(s => s.trim()).map(s => address(s.trim())));
    this.treasury = env.CAMPUS_TREASURY_ADDRESS ? address(env.CAMPUS_TREASURY_ADDRESS.trim()) : undefined;
    const amount = env.CAMPUS_SCHOLARSHIP_WEI ?? "1000000000000000000000";
    if (!/^[1-9][0-9]*$/.test(amount) || BigInt(amount) >= 2n ** 256n) throw Error("Invalid scholarship amount");
    this.scholarshipWei = BigInt(amount); this.rpc = rpc ?? new HttpInvoiceRpc(env.INTRACAMPUS_RPC_URL);
  }
  requireSchool(wallet: string) { if (!this.schools.has(wallet.toLowerCase())) throw new CampusError("SCHOOL_ONLY", 403); }
  async freshBlock() {
    if (hex(await this.rpc.call("eth_chainId", [])) !== BigInt(this.chainId)) throw new CampusError("WRONG_CHAIN", 503);
    const block = object(await this.rpc.call("eth_getBlockByNumber", ["latest", false]));
    const number = Number(hex(block.number)), timestamp = Number(hex(block.timestamp));
    if (!Number.isSafeInteger(number) || !/^0x[0-9a-f]{64}$/i.test(block.hash) || !isFreshInvoiceChainTimestamp(timestamp, Date.now(), defaultInvoiceChainFreshness)) throw new CampusError("STALE_CHAIN_STATE", 503);
    return { number, hash: String(block.hash).toLowerCase(), tag: String(block.number) };
  }
  async prepare(actor: string, wallet: string, kind: CampusPayout["kind"]) {
    this.requireSchool(actor); wallet = address(wallet); actor = address(actor);
    const profile = this.repository.profile(wallet);
    if (profile.application?.status !== "APPROVED") throw new CampusError("STUDENT_NOT_VERIFIED", 403);
    if (kind === "SCHOLARSHIP" && profile.scholarship?.status !== "APPROVED") throw new CampusError("SCHOLARSHIP_NOT_APPROVED", 403);
    if (kind === "WELCOME" && this.chainId === CLOUD_CAMPUS_CHAIN_ID) throw new CampusError("ADMIN_BACKFILL_REQUIRED", 403);
    const prior = profile.payouts.find(p => p.kind === kind); if (prior) return prior;
    const block = await this.freshBlock();
    const overrides = this.resolveOverrides?.();
    const activeTreasury = overrides?.welcomeTreasury ? address(overrides.welcomeTreasury) : this.treasury;
    const activeScholarshipWei = overrides?.scholarshipWei && /^[1-9][0-9]*$/.test(overrides.scholarshipWei)
      ? BigInt(overrides.scholarshipWei) : this.scholarshipWei;
    let to = wallet, value = welcomeWei, data = (id: string) => hexlify(toUtf8Bytes(`IntraCampus:welcome:${id}`));
    if (kind === "WELCOME") {
      if (!activeTreasury || actor !== activeTreasury) throw new CampusError("TREASURY_ONLY", 403);
      if (await this.rpc.call("eth_getCode", [actor, block.tag]) !== "0x") throw new CampusError("EOA_TREASURY_REQUIRED", 503);
    } else {
      let manifest;
      try {
        const local = this.env.CAMPUS_ALLOW_LOCAL_ANVIL === "true";
        if (local && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(this.env.INTRACAMPUS_RPC_URL ?? "").hostname)) throw Error();
        manifest = requireDeployment(this.deployment, { allowLocal: local });
      } catch { throw new CampusError("DEPLOYMENT_NOT_CONFIGURED", 503); }
      to = manifest.contracts.PurposeBoundGrantVault.address.toLowerCase(); value = activeScholarshipWei;
      if (actor !== manifest.roles.grantIssuer.toLowerCase()) throw new CampusError("GRANT_ISSUER_ONLY", 403);
      const code = await this.rpc.call("eth_getCode", [to, block.tag]);
      if (typeof code !== "string" || keccak256(code) !== manifest.contracts.PurposeBoundGrantVault.runtimeCodeHash.toLowerCase()) throw new CampusError("INVALID_DEPLOYMENT", 503);
      const issuer = await this.rpc.call("eth_call", [{ to, data: grantAbi.encodeFunctionData("issuer") }, block.tag]);
      if (typeof issuer !== "string" || String(grantAbi.decodeFunctionResult("issuer", issuer)[0]).toLowerCase() !== actor) throw new CampusError("GRANT_ISSUER_ONLY", 403);
      data = () => grantAbi.encodeFunctionData("grant", [wallet, manifest.merchants.canteen.category]);
    }
    const current = object(await this.rpc.call("eth_getBlockByNumber", [block.tag, false]));
    if (String(current.hash).toLowerCase() !== block.hash) throw new CampusError("STALE_CHAIN_STATE", 503);
    return this.repository.prepare({ wallet, kind, from: actor, to, value: `0x${value.toString(16)}`, afterBlock: block.number, data });
  }

  async issueWelcome(walletInput: string): Promise<CampusPayout> {
    const wallet = address(walletInput);
    if (this.chainId !== CLOUD_CAMPUS_CHAIN_ID) throw new CampusError("CLOUD_CHAIN_REQUIRED", 409);
    if (!this.nativeMinter) throw new CampusError("NATIVE_MINTER_NOT_CONFIGURED", 503);
    if (this.repository.profile(wallet).application?.status !== "APPROVED") throw new CampusError("STUDENT_NOT_VERIFIED", 403);
    const prior = this.repository.profile(wallet).payouts.find(p => p.kind === "WELCOME");
    if (prior) {
      if (prior.status === "CONFIRMED" || prior.status === "FAILED") return prior;
      if (prior.txHash) return this.reconcile(prior.id, prior.txHash);
      if (prior.executionType !== "NATIVE_MINT") throw new CampusError("WELCOME_PAYOUT_EXISTS", 409);
    }
    const readiness = await this.nativeMinter.readiness();
    if (!readiness.ready || !readiness.signerAddress) {
      const code = readiness.reason ?? "NATIVE_MINTER_ROLE_MISSING";
      throw new CampusError(code, ["NATIVE_MINTER_ROLE_MISSING", "WRONG_CHAIN"].includes(code) ? 409 : 503);
    }
    const block = await this.freshBlock();
    const data = nativeMinterAbi.encodeFunctionData("mintNativeCoin", [wallet, WELCOME_MINT_WEI]);
    const current = object(await this.rpc.call("eth_getBlockByNumber", [block.tag, false]));
    if (String(current.hash).toLowerCase() !== block.hash) throw new CampusError("STALE_CHAIN_STATE", 503);
    const payout = this.repository.prepare({
      wallet,
      kind: "WELCOME",
      from: address(readiness.signerAddress),
      to: NATIVE_MINTER_ADDRESS,
      value: "0x0",
      afterBlock: block.number,
      executionType: "NATIVE_MINT",
      mintAmountWei: WELCOME_MINT_WEI.toString(),
      data: () => data,
    });
    if (payout.status === "CONFIRMED" || payout.status === "FAILED") return payout;
    if (payout.txHash) return this.reconcile(payout.id, payout.txHash);
    const attempt = this.repository.beginSystemPayout(payout.id);
    if (!attempt.attemptToken) return attempt.payout;
    try {
      const sent = await this.nativeMinter.mint({
        recipient: wallet,
        amountWei: WELCOME_MINT_WEI,
        maxAmountWei: WELCOME_MINT_WEI,
        beforeBroadcast: txHash => { this.repository.attach(payout.id, txHash); },
      });
      return this.reconcile(payout.id, sent.txHash);
    } catch (error) {
      const latest = this.repository.payout(payout.id);
      if (!latest.txHash) this.repository.release(payout.id, payout.from, attempt.attemptToken, "NOT_SENT");
      if (error instanceof NativeMinterError) throw new CampusError(error.code, error.httpStatus);
      if (error instanceof CampusError) throw error;
      throw new CampusError("NATIVE_MINT_UNAVAILABLE", 503);
    }
  }

  async review(actor: string, wallet: string, kind: "STUDENT" | "SCHOLARSHIP", approve: boolean, reason: string) {
    this.requireSchool(actor);
    const profile = this.repository.review(actor, address(wallet), kind, approve, reason);
    let welcomeMint: { status: "CONFIRMED" | "PENDING" | "NOT_READY" | "FAILED"; txHash: string | null; errorCode?: string } | undefined;
    if (approve && kind === "STUDENT" && this.chainId === CLOUD_CAMPUS_CHAIN_ID) {
      try {
        const payout = await this.issueWelcome(wallet);
        welcomeMint = { status: payout.status === "CONFIRMED" ? "CONFIRMED" : payout.status === "FAILED" ? "FAILED" : "PENDING", txHash: payout.txHash };
      } catch (error) {
        const errorCode = error && typeof error === "object" && "code" in error ? String(error.code) : "NATIVE_MINT_UNAVAILABLE";
        welcomeMint = { status: "NOT_READY", txHash: null, errorCode };
      }
    }
    return { profile: this.repository.profile(profile.application?.wallet ?? wallet), ...(welcomeMint ? { welcomeMint } : {}) };
  }
  async reconcile(id: string, hash: string) {
    const p = this.repository.payout(id);
    if (!/^0x[0-9a-f]{64}$/i.test(hash) || /^0x0{64}$/i.test(hash)) throw new CampusError("INVALID_HASH", 400);
    hash = hash.toLowerCase(); this.repository.attach(id, hash);
    const head = await this.freshBlock();
    const raw = await this.rpc.call("eth_getTransactionReceipt", [hash]);
    if (!raw) return this.repository.payout(id);
    const receipt = object(raw), tx = object(await this.rpc.call("eth_getTransactionByHash", [hash]));
    const block = object(await this.rpc.call("eth_getBlockByNumber", [receipt.blockNumber, false]));
    if (!["0x0", "0x1"].includes(receipt.status) || String(receipt.transactionHash).toLowerCase() !== hash || String(tx.hash).toLowerCase() !== hash
      || !/^0x[0-9a-f]{64}$/i.test(receipt.blockHash) || hex(block.number) !== hex(receipt.blockNumber)
      || hex(receipt.blockNumber) > BigInt(head.number)
      || Number(hex(receipt.blockNumber)) <= p.afterBlock || Number(hex(tx.blockNumber)) !== Number(hex(receipt.blockNumber))
      || String(block.hash).toLowerCase() !== String(receipt.blockHash).toLowerCase() || String(tx.blockHash).toLowerCase() !== String(receipt.blockHash).toLowerCase()
      || String(tx.from).toLowerCase() !== p.from || String(tx.to).toLowerCase() !== p.to
      || String(tx.input).toLowerCase() !== p.data.toLowerCase() || hex(tx.value) !== BigInt(p.value) || hex(tx.chainId) !== BigInt(this.chainId)) throw new CampusError("RECEIPT_MISMATCH");
    if (receipt.status === "0x1" && p.kind === "SCHOLARSHIP") {
      const call = grantAbi.decodeFunctionData("grant", p.data);
      const found = Array.isArray(receipt.logs) && receipt.logs.some((log: any) => {
        if (String(log.address).toLowerCase() !== p.to || String(log.transactionHash).toLowerCase() !== hash || log.removed
          || String(log.blockHash).toLowerCase() !== String(receipt.blockHash).toLowerCase() || log.blockNumber !== receipt.blockNumber) return false;
        try { const event = grantAbi.parseLog(log); return event?.name === "GrantIssued" && event.args.beneficiary.toLowerCase() === p.wallet
          && event.args.category === call[1] && event.args.issuer.toLowerCase() === p.from && event.args.amount === BigInt(p.value); } catch { return false; }
      });
      if (!found) throw new CampusError("RECEIPT_MISMATCH");
    }
    if (receipt.status === "0x1" && p.executionType === "NATIVE_MINT") {
      const call = nativeMinterAbi.decodeFunctionData("mintNativeCoin", p.data);
      const found = Array.isArray(receipt.logs) && receipt.logs.some((log: any) => {
        if (String(log.address).toLowerCase() !== NATIVE_MINTER_ADDRESS.toLowerCase()
          || String(log.transactionHash).toLowerCase() !== hash || log.removed
          || String(log.blockHash).toLowerCase() !== String(receipt.blockHash).toLowerCase()
          || String(log.blockNumber).toLowerCase() !== String(receipt.blockNumber).toLowerCase()) return false;
        const event = NativeMinterService.decodeMintEvent(log);
        return event?.sender.toLowerCase() === p.from && event.recipient.toLowerCase() === p.wallet
          && event.amountWei === BigInt(p.mintAmountWei ?? "0")
          && event.recipient.toLowerCase() === String(call[0]).toLowerCase() && event.amountWei === BigInt(call[1]);
      });
      if (!found) throw new CampusError("RECEIPT_MISMATCH");
    }
    const finalBlock = object(await this.rpc.call("eth_getBlockByNumber", [receipt.blockNumber, false]));
    if (hex(finalBlock.number) !== hex(receipt.blockNumber) || String(finalBlock.hash).toLowerCase() !== String(receipt.blockHash).toLowerCase()) throw new CampusError("STALE_CHAIN_STATE", 503);
    return this.repository.finish(id, hash, receipt.status === "0x1" ? "CONFIRMED" : "FAILED");
  }
  async begin(id: string, actor: string, attemptToken: unknown) {
    this.requireSchool(actor);
    if (typeof attemptToken !== "string" || !/^[0-9a-f]{64}$/.test(attemptToken)) throw new CampusError("INVALID_REQUEST", 400);
    const p = this.repository.payout(id);
    if (p.executionType === "NATIVE_MINT") throw new CampusError("SERVER_SIGNED_PAYOUT", 409);
    if (!["PREPARED", "UNKNOWN"].includes(p.status) || p.from !== actor.toLowerCase() || p.txHash) throw new CampusError("PAYOUT_LOCKED");
    const block = await this.freshBlock();
    const gas = hex(await this.rpc.call("eth_estimateGas", [{ from: p.from, to: p.to, data: p.data, value: p.value }]));
    if (gas === 0n) throw new CampusError("RPC_UNAVAILABLE", 503);
    const current = object(await this.rpc.call("eth_getBlockByNumber", [block.tag, false]));
    if (String(current.hash).toLowerCase() !== block.hash) throw new CampusError("STALE_CHAIN_STATE", 503);
    return this.repository.begin(id, actor, attemptToken);
  }
  release(id: string, actor: string, attemptToken: unknown, outcome: unknown) {
    this.requireSchool(actor);
    if (typeof attemptToken !== "string" || !/^[0-9a-f]{64}$/.test(attemptToken) || (outcome !== "REJECTED" && outcome !== "NOT_SENT")) throw new CampusError("INVALID_REQUEST", 400);
    return this.repository.release(id, actor, attemptToken, outcome);
  }
}
