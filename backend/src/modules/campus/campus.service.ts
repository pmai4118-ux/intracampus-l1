import { getAddress, hexlify, toUtf8Bytes, Interface, keccak256 } from "ethers";
import { requireDeployment, resolveCampusChainId, type CampusChainId, type CampusPayout } from "@intracampus/network";
import { AuthService } from "../auth/auth.service.ts";
import { readLibraryAuthConfig, type LibraryAuthConfig } from "../auth/auth.config.ts";
import { HttpInvoiceRpc, type InvoiceRpc } from "../invoices/invoices.rpc.ts";
import { isFreshInvoiceChainTimestamp, defaultInvoiceChainFreshness } from "../invoices/chain-freshness.ts";
import { CampusError, CampusRepository } from "./campus.repository.ts";

export const welcomeWei = 20n * 10n ** 18n;
const grantAbi = new Interface(["function issuer() view returns(address)", "function grant(address,bytes32) payable", "event GrantIssued(address indexed beneficiary,bytes32 indexed category,address indexed issuer,uint256 amount,uint256 balance)"]);
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
  constructor(repository: CampusRepository, env: Record<string, string | undefined>, rpc?: InvoiceRpc, deployment?: unknown,
    resolveOverrides?: () => { welcomeTreasury?: string | null; scholarshipWei?: string | null }) {
    this.repository = repository; this.env = env; this.deployment = deployment;
    this.resolveOverrides = resolveOverrides;
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
    const finalBlock = object(await this.rpc.call("eth_getBlockByNumber", [receipt.blockNumber, false]));
    if (hex(finalBlock.number) !== hex(receipt.blockNumber) || String(finalBlock.hash).toLowerCase() !== String(receipt.blockHash).toLowerCase()) throw new CampusError("STALE_CHAIN_STATE", 503);
    return this.repository.finish(id, hash, receipt.status === "0x1" ? "CONFIRMED" : "FAILED");
  }
  async begin(id: string, actor: string, attemptToken: unknown) {
    this.requireSchool(actor);
    if (typeof attemptToken !== "string" || !/^[0-9a-f]{64}$/.test(attemptToken)) throw new CampusError("INVALID_REQUEST", 400);
    const p = this.repository.payout(id);
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
