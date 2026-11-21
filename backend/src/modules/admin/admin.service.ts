import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Interface, Wallet, getAddress, id, type InterfaceAbi } from "ethers";
import {
  CAMPUS_CHAIN_ID,
  campusNetwork,
  getDeployment,
  getLibraryDeployment,
  libraryEscrowSupportsRoleUpdates,
  requireDeployment,
  requireLibraryDeployment,
  type AdminAuditEntry,
  type AdminOverview,
  type AdminSignerStatus,
  type AdminStudentRecord,
  type AdminTxStatus,
  type DeployedLibraryDeployment,
  type DeployedManifest,
  type RuntimeWalletConfig,
} from "@intracampus/network";
import type { CampusRepository } from "../campus/campus.repository.ts";
import type { LibraryRepository } from "../library/library.repository.ts";
import type { AdminConfig, AdminSignerRole } from "./admin.config.ts";
import type { AdminRepository } from "./admin.repository.ts";
import { AdminChainError, JsonRpcAdminClient, type AdminRpcClient } from "./admin.signer.ts";

const PARKING_CATEGORY = id("PARKING");
const FOOD_CATEGORY = id("FOOD");
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const UINT_RE = /^[1-9][0-9]*$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;

const REGISTRY_IFACE = new Interface([
  "function admin() view returns (address)",
  "function allowedMerchantCategories(address merchant, bytes32 category) view returns (bool)",
  "function setMerchantCategory(address merchant, bytes32 category, bool allowed)",
]);

const SBT_IFACE = new Interface([
  "function issuer() view returns (address)",
  "function credentials(address wallet) view returns (uint256 tokenId, uint64 expiresAt)",
  "function tierOf(address wallet) view returns (uint8)",
  "function mint(address wallet, uint64 expiresAt) returns (uint256)",
  "function revoke(uint256 tokenId)",
]);

const VAULT_IFACE = new Interface([
  "function issuer() view returns (address)",
  "function balances(address beneficiary, bytes32 category) view returns (uint256)",
  "function grant(address beneficiary, bytes32 category) payable",
]);

const ESCROW_IFACE = new Interface([
  "function administrator() view returns (address)",
  "function librarian() view returns (address)",
  "function treasury() view returns (address)",
  "function setTreasury(address newTreasury)",
  "function setLibrarian(address newLibrarian)",
]);

const same = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

function sha256Buffer(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class AdminServiceError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryAfterSeconds?: number;
  constructor(code: string, httpStatus = 400, retryAfterSeconds?: number) {
    super(code);
    this.name = "AdminServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function normalizeAddress(value: unknown, code = "INVALID_ADDRESS"): string {
  if (typeof value !== "string") throw new AdminServiceError(code, 400);
  try {
    const addr = getAddress(value.trim());
    if (/^0x0{40}$/i.test(addr)) throw new Error();
    return addr;
  } catch {
    throw new AdminServiceError(code, 400);
  }
}

function normalizePositiveWei(value: unknown, code = "INVALID_AMOUNT"): bigint {
  if (typeof value !== "string" || !UINT_RE.test(value.trim())) throw new AdminServiceError(code, 400);
  const amount = BigInt(value.trim());
  if (amount <= 0n || amount > MAX_UINT256) throw new AdminServiceError(code, 400);
  return amount;
}

function decodeAddressWord(raw: string, iface: Interface, fn: string): string | null {
  if (!/^0x0{24}[0-9a-f]{40}$/i.test(raw) || /^0x0{64}$/i.test(raw)) return null;
  try {
    return getAddress(String(iface.decodeFunctionResult(fn, raw)[0]));
  } catch {
    return null;
  }
}

export type AdminServiceDependencies = {
  config?: AdminConfig;
  repository: AdminRepository;
  libraryRepository?: LibraryRepository;
  campusRepository?: CampusRepository;
  rpc?: AdminRpcClient;
  rpcUrl?: string;
  allowLocal?: boolean;
  deployment?: unknown;
  now?: () => number;
};

export class AdminService {
  readonly config?: AdminConfig;
  readonly repository: AdminRepository;
  private readonly libraryRepository?: LibraryRepository;
  private readonly campusRepository?: CampusRepository;
  private rpc?: AdminRpcClient;
  private ownsRpc = false;
  private readonly fallbackRpcUrl?: string;
  private readonly allowLocal: boolean;
  private readonly deploymentSource?: unknown;
  private readonly now: () => number;

  constructor(deps: AdminServiceDependencies) {
    this.config = deps.config;
    this.repository = deps.repository;
    this.libraryRepository = deps.libraryRepository;
    this.campusRepository = deps.campusRepository;
    this.rpc = deps.rpc;
    this.fallbackRpcUrl = deps.rpcUrl;
    this.allowLocal = deps.config?.allowLocal ?? deps.allowLocal ?? false;
    this.deploymentSource = deps.deployment;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  close(): void {
    if (this.ownsRpc) {
      this.rpc?.close?.();
      this.rpc = undefined;
    }
  }

  private requireConfig(): AdminConfig {
    if (!this.config) throw new AdminServiceError("CONFIGURATION_ERROR", 503);
    return this.config;
  }

  private getRpc(): AdminRpcClient | undefined {
    if (this.rpc) return this.rpc;
    const rpcUrl = this.config?.rpcUrl ?? this.fallbackRpcUrl;
    if (!rpcUrl) return undefined;
    try {
      this.rpc = new JsonRpcAdminClient(rpcUrl);
      this.ownsRpc = true;
      return this.rpc;
    } catch {
      return undefined;
    }
  }

  private requireRpc(): AdminRpcClient {
    const rpc = this.getRpc();
    if (!rpc) throw new AdminServiceError("RPC_UNAVAILABLE", 503);
    return rpc;
  }

  private deployedCore(): DeployedManifest | null {
    try {
      return requireDeployment(this.deploymentSource ?? getDeployment(), { allowLocal: this.allowLocal });
    } catch {
      return null;
    }
  }

  private deployedLibrary(): DeployedLibraryDeployment | null {
    try {
      return requireLibraryDeployment(this.deploymentSource ?? getDeployment(), { allowLocal: this.allowLocal }).library;
    } catch {
      try {
        const view = getLibraryDeployment(this.deploymentSource ?? getDeployment());
        return view.status === "deployed" && (this.allowLocal || view.environment === "avalanche-l1") ? view : null;
      } catch {
        return null;
      }
    }
  }

  // ---- Runtime wallet resolvers consumed by invoices, parking, canteen, grants, campus ----

  activeParkingMerchant(): string | undefined {
    return this.repository.getRuntimeValue("parking_merchant_address")
      ?? this.deployedCore()?.merchants.parking.address;
  }

  activeCanteenMerchant(): string | undefined {
    return this.repository.getRuntimeValue("canteen_merchant_address")
      ?? this.deployedCore()?.merchants.canteen.address;
  }

  campusOverrides(): { welcomeTreasury: string | null; scholarshipWei: string } {
    return {
      welcomeTreasury: this.repository.getRuntimeValue("welcome_treasury_address")
        ?? this.config?.defaultWelcomeTreasury
        ?? null,
      scholarshipWei: this.repository.getRuntimeValue("scholarship_wei")
        ?? this.config?.defaultScholarshipWei
        ?? "1000000000000000000000",
    };
  }

  async readLiveLibraryRoles(): Promise<{
    treasury: string | null;
    librarian: string | null;
    supportsTreasuryUpdate: boolean;
    supportsLibrarianUpdate: boolean;
  }> {
    const lib = this.deployedLibrary();
    if (!lib) {
      return { treasury: null, librarian: null, supportsTreasuryUpdate: false, supportsLibrarianUpdate: false };
    }
    const supports = libraryEscrowSupportsRoleUpdates(lib.escrow.abi);
    let treasury = lib.treasury;
    let librarian = lib.roles.librarian;
    const rpc = this.getRpc();
    if (rpc) {
      try {
        const [rawTreasury, rawLibrarian] = await Promise.all([
          rpc.call(lib.escrow.address, ESCROW_IFACE.encodeFunctionData("treasury")),
          rpc.call(lib.escrow.address, ESCROW_IFACE.encodeFunctionData("librarian")),
        ]);
        treasury = decodeAddressWord(rawTreasury, ESCROW_IFACE, "treasury") ?? treasury;
        librarian = decodeAddressWord(rawLibrarian, ESCROW_IFACE, "librarian") ?? librarian;
      } catch {
        // Fallback to manifest values when RPC is temporarily unavailable.
      }
    }
    return {
      treasury,
      librarian,
      supportsTreasuryUpdate: supports.treasury,
      supportsLibrarianUpdate: supports.librarian,
    };
  }

  async getPublicRuntimeConfig(): Promise<RuntimeWalletConfig> {
    const snapshot = this.repository.getRuntimeSnapshot();
    const liveLibrary = await this.readLiveLibraryRoles();
    const overrides = this.campusOverrides();
    return {
      chainId: CAMPUS_CHAIN_ID,
      parkingMerchant: this.activeParkingMerchant() ?? null,
      canteenMerchant: this.activeCanteenMerchant() ?? null,
      libraryTreasury: liveLibrary.treasury,
      libraryLibrarian: liveLibrary.librarian,
      welcomeTreasury: overrides.welcomeTreasury,
      scholarshipWei: overrides.scholarshipWei,
      updatedAt: snapshot.updatedAt || this.now(),
    };
  }

  // ---- Fixed-key session auth ----

  login(input: { key: unknown; remoteAddress: string }): { token: string; expiresAt: number } {
    const config = this.requireConfig();
    const now = this.now();
    const bucket = sha256Hex(`admin-login:${input.remoteAddress || "unknown"}`);
    const limit = this.repository.consumeLoginRateLimit(
      bucket,
      now,
      config.loginRateLimit.maxRequests,
      config.loginRateLimit.windowSeconds,
    );
    if (!limit.allowed) throw new AdminServiceError("RATE_LIMITED", 429, limit.retryAfterSeconds);
    if (typeof input.key !== "string" || !input.key.trim()) {
      throw new AdminServiceError("INVALID_ACCESS_KEY", 401);
    }
    const provided = sha256Buffer(input.key.trim());
    const expected = sha256Buffer(config.accessKey);
    if (!timingSafeEqual(provided, expected)) {
      throw new AdminServiceError("INVALID_ACCESS_KEY", 401);
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + config.sessionTtlSeconds;
    this.repository.createSession(sha256Hex(token), now, expiresAt);
    return { token, expiresAt };
  }

  verifySession(token: unknown): { expiresAt: number } | undefined {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const session = this.repository.getSession(sha256Hex(token), this.now());
    return session ? { expiresAt: session.expiresAt } : undefined;
  }

  logout(token: unknown): void {
    if (typeof token === "string" && token.length > 0) {
      this.repository.revokeSession(sha256Hex(token));
    }
  }

  // ---- Overview & status ----

  private async safeBalance(address: string | null): Promise<string | null> {
    if (!address) return null;
    const rpc = this.getRpc();
    if (!rpc) return null;
    try {
      return (await rpc.getBalance(address)).toString();
    } catch {
      return null;
    }
  }

  private async isMerchantAllowedOnChain(merchant: string | null, category: string): Promise<boolean | null> {
    const core = this.deployedCore();
    const rpc = this.getRpc();
    if (!core || !rpc || !merchant) return null;
    try {
      const raw = await rpc.call(
        core.contracts.CampusPaymentRegistry.address,
        REGISTRY_IFACE.encodeFunctionData("allowedMerchantCategories", [merchant, category]),
      );
      if (!/^0x0{63}[01]$/i.test(raw)) return null;
      return Boolean(REGISTRY_IFACE.decodeFunctionResult("allowedMerchantCategories", raw)[0]);
    } catch {
      return null;
    }
  }

  private async readSignerStatuses(core: DeployedManifest | null, lib: DeployedLibraryDeployment | null): Promise<AdminSignerStatus[]> {
    const config = this.requireConfig();
    const roles: Array<{ role: AdminSignerRole; label: string; expected: string | null }> = [
      { role: "registryAdmin", label: "Quản trị Registry (Bãi xe & Nhà ăn)", expected: core?.roles.deployer ?? null },
      { role: "libraryAdmin", label: "Quản trị Escrow Thư viện", expected: lib?.roles.administrator ?? null },
      { role: "sbtIssuer", label: "Cấp thẻ sinh viên SBT", expected: core?.roles.sbtIssuer ?? null },
      { role: "grantIssuer", label: "Giải ngân học bổng FOOD", expected: core?.roles.grantIssuer ?? null },
      { role: "funder", label: "Ví cấp CAMPUS test / gas", expected: null },
    ];
    return Promise.all(roles.map(async ({ role, label, expected }) => {
      const privateKey = config.signers[role];
      const signerAddress = privateKey ? new Wallet(privateKey).address : null;
      const matchesOnChain = signerAddress && expected ? same(signerAddress, expected) : null;
      const balanceWei = await this.safeBalance(signerAddress);
      return {
        role,
        label,
        configured: Boolean(privateKey),
        expectedAddress: expected,
        signerAddress,
        matchesOnChain,
        balanceWei,
      };
    }));
  }

  async getOverview(): Promise<AdminOverview> {
    const core = this.deployedCore();
    const lib = this.deployedLibrary();
    const rpc = this.getRpc();
    const block = rpc ? await rpc.latestBlock() : null;
    const liveLib = await this.readLiveLibraryRoles();
    const parkingAddr = this.activeParkingMerchant() ?? null;
    const canteenAddr = this.activeCanteenMerchant() ?? null;

    const [
      parkingBalance,
      canteenBalance,
      libTreasuryBalance,
      libLibrarianBalance,
      parkingAllowed,
      canteenAllowed,
      signers,
    ] = await Promise.all([
      this.safeBalance(parkingAddr),
      this.safeBalance(canteenAddr),
      this.safeBalance(liveLib.treasury),
      this.safeBalance(liveLib.librarian),
      this.isMerchantAllowedOnChain(parkingAddr, PARKING_CATEGORY),
      this.isMerchantAllowedOnChain(canteenAddr, FOOD_CATEGORY),
      this.readSignerStatuses(core, lib),
    ]);

    const profiles = this.campusRepository?.list() ?? [];
    const accounts = this.libraryRepository?.listAccountsWithHolds() ?? [];
    const overrides = this.campusOverrides();

    return {
      chainId: CAMPUS_CHAIN_ID,
      networkName: campusNetwork.name,
      deploymentStatus: core ? "deployed" : "unconfigured",
      blockNumber: block?.number ?? null,
      blockTimestamp: block?.timestamp ?? null,
      contracts: {
        studentSbt: core?.contracts.StudentSBTIdentity.address ?? null,
        paymentRegistry: core?.contracts.CampusPaymentRegistry.address ?? null,
        grantVault: core?.contracts.PurposeBoundGrantVault.address ?? null,
        libraryEscrow: lib?.escrow.address ?? null,
      },
      wallets: {
        parking: {
          id: "parking",
          label: "Ví Bãi xe (PARKING)",
          description: "Nhận phí gửi xe và có quyền xác nhận cổng ra /staff/parking.",
          address: parkingAddr,
          manifestAddress: core?.merchants.parking.address ?? null,
          overridden: Boolean(this.repository.getRuntimeValue("parking_merchant_address")),
          balanceWei: parkingBalance,
          allowedOnChain: parkingAllowed,
          mutableOnChain: Boolean(core),
          mutableReason: core ? null : "Chưa có manifest triển khai CampusPaymentRegistry.",
        },
        canteen: {
          id: "canteen",
          label: "Ví Nhà ăn (FOOD)",
          description: "Nhận tiền đặt món từ ví sinh viên và từ học bổng FOOD.",
          address: canteenAddr,
          manifestAddress: core?.merchants.canteen.address ?? null,
          overridden: Boolean(this.repository.getRuntimeValue("canteen_merchant_address")),
          balanceWei: canteenBalance,
          allowedOnChain: canteenAllowed,
          mutableOnChain: Boolean(core),
          mutableReason: core ? null : "Chưa có manifest triển khai CampusPaymentRegistry.",
        },
        libraryTreasury: {
          id: "libraryTreasury",
          label: "Ví nhận Thư viện (Treasury)",
          description: "Nhận tiền phạt trễ hạn, phí sửa chữa, cọc giữ lại và đền bù mất sách.",
          address: liveLib.treasury,
          manifestAddress: lib?.treasury ?? null,
          overridden: Boolean(lib && liveLib.treasury && !same(liveLib.treasury, lib.treasury)),
          balanceWei: libTreasuryBalance,
          allowedOnChain: null,
          mutableOnChain: liveLib.supportsTreasuryUpdate,
          mutableReason: !lib
            ? "Chưa có manifest LibraryDepositEscrow."
            : liveLib.supportsTreasuryUpdate
              ? null
              : "Contract LibraryDepositEscrow đang deploy chưa hỗ trợ setTreasury — cần redeploy bản mới trên VM.",
        },
        libraryLibrarian: {
          id: "libraryLibrarian",
          label: "Ví Thủ thư (Librarian)",
          description: "Ví có quyền đăng nhập /staff/library, duyệt mượn, xác nhận trả và quyết toán.",
          address: liveLib.librarian,
          manifestAddress: lib?.roles.librarian ?? null,
          overridden: Boolean(lib && liveLib.librarian && !same(liveLib.librarian, lib.roles.librarian)),
          balanceWei: libLibrarianBalance,
          allowedOnChain: null,
          mutableOnChain: liveLib.supportsLibrarianUpdate,
          mutableReason: !lib
            ? "Chưa có manifest LibraryDepositEscrow."
            : liveLib.supportsLibrarianUpdate
              ? null
              : "Contract LibraryDepositEscrow đang deploy chưa hỗ trợ setLibrarian — cần redeploy bản mới trên VM.",
        },
      },
      campusSettings: {
        welcomeTreasury: overrides.welcomeTreasury,
        scholarshipWei: overrides.scholarshipWei,
      },
      signers,
      counts: {
        applicationsTotal: profiles.filter((p) => p.application).length,
        applicationsPending: profiles.filter((p) => p.application?.status === "PENDING").length,
        applicationsApproved: profiles.filter((p) => p.application?.status === "APPROVED").length,
        scholarshipsPending: profiles.filter((p) => p.scholarship?.status === "PENDING").length,
        scholarshipsApproved: profiles.filter((p) => p.scholarship?.status === "APPROVED").length,
        heldAccounts: accounts.filter((a) => a.held).length,
      },
    };
  }

  // ---- On-chain signer helper ----

  private requireSignerKey(role: AdminSignerRole, expectedAddress?: string | null): string {
    const config = this.requireConfig();
    const key = config.signers[role];
    if (!key) throw new AdminServiceError("SIGNER_NOT_CONFIGURED", 503);
    if (expectedAddress && !same(new Wallet(key).address, expectedAddress)) {
      throw new AdminServiceError("SIGNER_ROLE_MISMATCH", 503);
    }
    return key;
  }

  private normalizeChainError(error: unknown): never {
    if (error instanceof AdminServiceError) throw error;
    if (error instanceof AdminChainError) throw new AdminServiceError(error.code, error.httpStatus);
    throw new AdminServiceError("INTERNAL_ERROR", 500);
  }

  // ---- Destination wallet mutations ----

  async updateMerchantWallet(input: {
    kind: "PARKING" | "FOOD";
    address: string;
    revokePrevious?: boolean;
  }): Promise<{ address: string; txHashes: string[]; audit: AdminAuditEntry }> {
    const nextAddress = normalizeAddress(input.address);
    const core = this.deployedCore();
    if (!core) throw new AdminServiceError("DEPLOYMENT_NOT_CONFIGURED", 503);
    const contracts = Object.values(core.contracts).map((c) => c.address);
    if (contracts.some((addr) => same(addr, nextAddress))) {
      throw new AdminServiceError("INVALID_MERCHANT_ADDRESS", 400);
    }
    if (input.kind === "PARKING" && this.libraryRepository) {
      const existing = this.libraryRepository.accountForWallet(nextAddress);
      if (existing && existing.role !== "PARKING") {
        throw new AdminServiceError("PARKING_OPERATOR_ROLE_CONFLICT", 409);
      }
    }

    const category = input.kind === "PARKING" ? PARKING_CATEGORY : FOOD_CATEGORY;
    const previous = input.kind === "PARKING" ? this.activeParkingMerchant() : this.activeCanteenMerchant();
    const txHashes: string[] = [];

    try {
      const alreadyAllowed = await this.isMerchantAllowedOnChain(nextAddress, category);
      if (alreadyAllowed !== true) {
        const key = this.requireSignerKey("registryAdmin", core.roles.deployer);
        const rpc = this.requireRpc();
        const data = REGISTRY_IFACE.encodeFunctionData("setMerchantCategory", [nextAddress, category, true]);
        const sent = await rpc.sendSignedTransaction({
          privateKey: key,
          to: core.contracts.CampusPaymentRegistry.address,
          data,
        });
        txHashes.push(sent.txHash);
      }
      if (input.revokePrevious && previous && !same(previous, nextAddress)) {
        const previousAllowed = await this.isMerchantAllowedOnChain(previous, category);
        if (previousAllowed === true) {
          const key = this.requireSignerKey("registryAdmin", core.roles.deployer);
          const rpc = this.requireRpc();
          const data = REGISTRY_IFACE.encodeFunctionData("setMerchantCategory", [previous, category, false]);
          const sent = await rpc.sendSignedTransaction({
            privateKey: key,
            to: core.contracts.CampusPaymentRegistry.address,
            data,
          });
          txHashes.push(sent.txHash);
        }
      }
    } catch (error) {
      this.normalizeChainError(error);
    }

    const configKey = input.kind === "PARKING" ? "parking_merchant_address" : "canteen_merchant_address";
    this.repository.setRuntimeValue(configKey, nextAddress, this.now());
    if (input.kind === "PARKING" && this.libraryRepository) {
      this.libraryRepository.registerParkingOperator(nextAddress);
    }
    const audit = this.repository.recordAudit({
      action: input.kind === "PARKING" ? "SET_PARKING_MERCHANT" : "SET_CANTEEN_MERCHANT",
      target: nextAddress,
      summary: `Đổi ví nhận ${input.kind} sang ${nextAddress}${input.revokePrevious && previous && !same(previous, nextAddress) ? ` (tắt ví cũ ${previous})` : ""}`,
      txHash: txHashes.at(-1) ?? null,
      status: txHashes.length > 0 ? "SUBMITTED" : "DONE",
      createdAt: this.now(),
    });
    return { address: nextAddress, txHashes, audit };
  }

  async setRegistryAllowlist(input: {
    merchant: string;
    category: "PARKING" | "FOOD";
    allowed: boolean;
  }): Promise<{ merchant: string; txHash: string; audit: AdminAuditEntry }> {
    const merchant = normalizeAddress(input.merchant);
    const core = this.deployedCore();
    if (!core) throw new AdminServiceError("DEPLOYMENT_NOT_CONFIGURED", 503);
    if (same(merchant, core.contracts.CampusPaymentRegistry.address)) {
      throw new AdminServiceError("INVALID_MERCHANT_ADDRESS", 400);
    }
    const key = this.requireSignerKey("registryAdmin", core.roles.deployer);
    const rpc = this.requireRpc();
    const categoryHash = input.category === "PARKING" ? PARKING_CATEGORY : FOOD_CATEGORY;
    let txHash: string;
    try {
      const sent = await rpc.sendSignedTransaction({
        privateKey: key,
        to: core.contracts.CampusPaymentRegistry.address,
        data: REGISTRY_IFACE.encodeFunctionData("setMerchantCategory", [merchant, categoryHash, input.allowed]),
      });
      txHash = sent.txHash;
    } catch (error) {
      this.normalizeChainError(error);
    }
    const audit = this.repository.recordAudit({
      action: "SET_REGISTRY_ALLOWLIST",
      target: merchant,
      summary: `${input.allowed ? "Bật" : "Tắt"} quyền nhận ${input.category} trên Registry cho ${merchant}`,
      txHash,
      status: "SUBMITTED",
      createdAt: this.now(),
    });
    return { merchant, txHash, audit };
  }

  async updateLibraryTreasury(address: string): Promise<{ address: string; txHash: string; audit: AdminAuditEntry }> {
    const nextTreasury = normalizeAddress(address);
    const lib = this.deployedLibrary();
    if (!lib) throw new AdminServiceError("LIBRARY_NOT_CONFIGURED", 503);
    const live = await this.readLiveLibraryRoles();
    if (!live.supportsTreasuryUpdate) {
      throw new AdminServiceError("ESCROW_UPGRADE_REQUIRED", 409);
    }
    if (same(nextTreasury, lib.escrow.address) || same(nextTreasury, lib.roles.administrator) || same(nextTreasury, live.librarian)) {
      throw new AdminServiceError("INVALID_LIBRARY_TREASURY", 400);
    }
    const key = this.requireSignerKey("libraryAdmin", lib.roles.administrator);
    const rpc = this.requireRpc();
    let txHash: string;
    try {
      const sent = await rpc.sendSignedTransaction({
        privateKey: key,
        to: lib.escrow.address,
        data: ESCROW_IFACE.encodeFunctionData("setTreasury", [nextTreasury]),
      });
      txHash = sent.txHash;
    } catch (error) {
      this.normalizeChainError(error);
    }
    const audit = this.repository.recordAudit({
      action: "SET_LIBRARY_TREASURY",
      target: nextTreasury,
      summary: `Đổi ví nhận Thư viện (treasury) sang ${nextTreasury}`,
      txHash,
      status: "SUBMITTED",
      createdAt: this.now(),
    });
    return { address: nextTreasury, txHash, audit };
  }

  async updateLibraryLibrarian(address: string): Promise<{ address: string; txHash: string; audit: AdminAuditEntry }> {
    const nextLibrarian = normalizeAddress(address);
    const lib = this.deployedLibrary();
    if (!lib) throw new AdminServiceError("LIBRARY_NOT_CONFIGURED", 503);
    const live = await this.readLiveLibraryRoles();
    if (!live.supportsLibrarianUpdate) {
      throw new AdminServiceError("ESCROW_UPGRADE_REQUIRED", 409);
    }
    if (same(nextLibrarian, lib.escrow.address) || same(nextLibrarian, live.treasury)) {
      throw new AdminServiceError("INVALID_LIBRARY_LIBRARIAN", 400);
    }
    if (this.libraryRepository) {
      const existing = this.libraryRepository.accountForWallet(nextLibrarian);
      if (existing && existing.role !== "LIBRARIAN") {
        throw new AdminServiceError("LIBRARIAN_OPERATOR_ROLE_CONFLICT", 409);
      }
    }
    const key = this.requireSignerKey("libraryAdmin", lib.roles.administrator);
    const rpc = this.requireRpc();
    let txHash: string;
    try {
      const sent = await rpc.sendSignedTransaction({
        privateKey: key,
        to: lib.escrow.address,
        data: ESCROW_IFACE.encodeFunctionData("setLibrarian", [nextLibrarian]),
      });
      txHash = sent.txHash;
    } catch (error) {
      this.normalizeChainError(error);
    }
    if (this.libraryRepository) {
      this.libraryRepository.registerLibrarianOperator(nextLibrarian);
    }
    const audit = this.repository.recordAudit({
      action: "SET_LIBRARY_LIBRARIAN",
      target: nextLibrarian,
      summary: `Đổi ví Thủ thư (librarian) sang ${nextLibrarian} và đồng bộ tài khoản đăng nhập`,
      txHash,
      status: "SUBMITTED",
      createdAt: this.now(),
    });
    return { address: nextLibrarian, txHash, audit };
  }

  updateCampusSettings(input: { welcomeTreasury?: string | null; scholarshipWei?: string | null }): {
    welcomeTreasury: string | null;
    scholarshipWei: string;
    audit: AdminAuditEntry;
  } {
    const changes: string[] = [];
    if (input.welcomeTreasury !== undefined) {
      if (input.welcomeTreasury === null || input.welcomeTreasury.trim() === "") {
        this.repository.deleteRuntimeValue("welcome_treasury_address");
        changes.push("đặt lại ví quỹ welcome về .env");
      } else {
        const addr = normalizeAddress(input.welcomeTreasury);
        this.repository.setRuntimeValue("welcome_treasury_address", addr, this.now());
        changes.push(`ví quỹ welcome = ${addr}`);
      }
    }
    if (input.scholarshipWei !== undefined) {
      if (input.scholarshipWei === null || input.scholarshipWei.trim() === "") {
        this.repository.deleteRuntimeValue("scholarship_wei");
        changes.push("đặt lại mức học bổng FOOD về mặc định");
      } else {
        const amount = normalizePositiveWei(input.scholarshipWei);
        this.repository.setRuntimeValue("scholarship_wei", amount.toString(), this.now());
        changes.push(`mức học bổng FOOD = ${amount.toString()} wei`);
      }
    }
    const current = this.campusOverrides();
    const audit = this.repository.recordAudit({
      action: "UPDATE_CAMPUS_SETTINGS",
      target: current.welcomeTreasury ?? "campus-settings",
      summary: changes.length ? `Cập nhật cấu hình Campus: ${changes.join("; ")}` : "Không có thay đổi cấu hình Campus",
      status: "DONE",
      createdAt: this.now(),
    });
    return { ...current, audit };
  }

  // ---- Student identity, SBT & FOOD scholarship ----

  private async readOnChainStudentState(wallet: string): Promise<AdminStudentRecord["onChain"]> {
    const core = this.deployedCore();
    const rpc = this.getRpc();
    if (!rpc) {
      return { balanceWei: null, sbtTokenId: null, sbtExpiresAt: null, sbtTier: null, foodGrantBalanceWei: null };
    }
    const [balanceWei, sbtData, tierData, grantData] = await Promise.all([
      this.safeBalance(wallet),
      core ? rpc.call(core.contracts.StudentSBTIdentity.address, SBT_IFACE.encodeFunctionData("credentials", [wallet])).catch(() => null) : Promise.resolve(null),
      core ? rpc.call(core.contracts.StudentSBTIdentity.address, SBT_IFACE.encodeFunctionData("tierOf", [wallet])).catch(() => null) : Promise.resolve(null),
      core ? rpc.call(core.contracts.PurposeBoundGrantVault.address, VAULT_IFACE.encodeFunctionData("balances", [wallet, FOOD_CATEGORY])).catch(() => null) : Promise.resolve(null),
    ]);
    let sbtTokenId: string | null = null;
    let sbtExpiresAt: number | null = null;
    if (sbtData && /^0x[0-9a-f]{128}$/i.test(sbtData)) {
      try {
        const [tokenId, expiresAt] = SBT_IFACE.decodeFunctionResult("credentials", sbtData);
        sbtTokenId = BigInt(tokenId).toString();
        sbtExpiresAt = Number(BigInt(expiresAt));
      } catch { /* ignore malformed */ }
    }
    let sbtTier: number | null = null;
    if (tierData && /^0x[0-9a-f]{64}$/i.test(tierData)) {
      try { sbtTier = Number(BigInt(SBT_IFACE.decodeFunctionResult("tierOf", tierData)[0])); } catch { /* ignore */ }
    }
    let foodGrantBalanceWei: string | null = null;
    if (grantData && /^0x[0-9a-f]{64}$/i.test(grantData)) {
      try { foodGrantBalanceWei = BigInt(VAULT_IFACE.decodeFunctionResult("balances", grantData)[0]).toString(); } catch { /* ignore */ }
    }
    return { balanceWei, sbtTokenId, sbtExpiresAt, sbtTier, foodGrantBalanceWei };
  }

  async inspectStudent(rawWallet: string): Promise<AdminStudentRecord> {
    const wallet = normalizeAddress(rawWallet);
    const profile = this.campusRepository?.profile(wallet) ?? { application: null, scholarship: null, payouts: [] };
    const accounts = this.libraryRepository?.listAccountsWithHolds() ?? [];
    const libAccount = accounts.find((entry) => same(entry.wallet, wallet)) ?? null;
    const onChain = await this.readOnChainStudentState(wallet);
    return {
      wallet,
      application: profile.application,
      scholarship: profile.scholarship,
      payouts: profile.payouts,
      libraryAccount: libAccount
        ? { role: libAccount.role, enabled: libAccount.enabled, held: libAccount.held, blockingLoanIds: libAccount.blockingLoanIds }
        : null,
      onChain,
    };
  }

  async listStudents(): Promise<AdminStudentRecord[]> {
    const profiles = this.campusRepository?.list() ?? [];
    const accounts = this.libraryRepository?.listAccountsWithHolds() ?? [];
    const walletSet = new Set<string>();
    const ordered: string[] = [];
    const push = (w: string) => {
      const lower = w.toLowerCase();
      if (!walletSet.has(lower)) {
        walletSet.add(lower);
        ordered.push(getAddress(w));
      }
    };
    for (const p of profiles) {
      if (p.application?.wallet) push(p.application.wallet);
      else if (p.scholarship?.wallet) push(p.scholarship.wallet);
    }
    for (const a of accounts) {
      if (a.role === "STUDENT") push(a.wallet);
    }
    const profileMap = new Map(profiles.map((p) => [(p.application?.wallet ?? p.scholarship?.wallet ?? "").toLowerCase(), p]));
    const accountMap = new Map(accounts.map((a) => [a.wallet.toLowerCase(), a]));

    const slice = ordered.slice(0, 60);
    return Promise.all(slice.map(async (wallet) => {
      const lower = wallet.toLowerCase();
      const profile = profileMap.get(lower) ?? { application: null, scholarship: null, payouts: [] };
      const acc = accountMap.get(lower) ?? null;
      const onChain = await this.readOnChainStudentState(wallet);
      return {
        wallet,
        application: profile.application,
        scholarship: profile.scholarship,
        payouts: profile.payouts,
        libraryAccount: acc
          ? { role: acc.role, enabled: acc.enabled, held: acc.held, blockingLoanIds: acc.blockingLoanIds }
          : null,
        onChain,
      };
    }));
  }

  async reviewStudent(input: {
    wallet: string;
    approve: boolean;
    studentCode?: string;
    program?: string;
    reason?: string;
    autoEnrollLibrary?: boolean;
  }): Promise<{ student: AdminStudentRecord; audit: AdminAuditEntry }> {
    const wallet = normalizeAddress(input.wallet);
    if (!this.campusRepository) throw new AdminServiceError("CONFIGURATION_ERROR", 503);
    try {
      this.campusRepository.adminReviewStudent("admin-console", wallet, input.approve, {
        studentCode: input.studentCode,
        program: input.program,
        reason: input.reason,
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "CONFLICT";
      const status = error && typeof error === "object" && "httpStatus" in error ? Number(error.httpStatus) : 409;
      throw new AdminServiceError(code, status);
    }
    if (input.approve && input.autoEnrollLibrary !== false && this.libraryRepository) {
      const existing = this.libraryRepository.accountForWallet(wallet);
      if (!existing) {
        this.libraryRepository.enrollVerifiedStudent(wallet);
      } else if (existing.role === "STUDENT" && !existing.enabled) {
        this.libraryRepository.setAccountEnabled(wallet, true, this.now());
      }
    }
    const audit = this.repository.recordAudit({
      action: input.approve ? "APPROVE_STUDENT" : "REJECT_STUDENT",
      target: wallet,
      summary: input.approve
        ? `Duyệt tư cách sinh viên cho ${wallet}${input.autoEnrollLibrary !== false ? " và kích hoạt dịch vụ" : ""}`
        : `Từ chối hồ sơ sinh viên ${wallet}`,
      status: "DONE",
      createdAt: this.now(),
    });
    return { student: await this.inspectStudent(wallet), audit };
  }

  async updateStudentAccess(input: {
    wallet: string;
    enabled?: boolean;
    releaseHolds?: boolean;
  }): Promise<{ student: AdminStudentRecord; releasedHolds: number; audit: AdminAuditEntry }> {
    const wallet = normalizeAddress(input.wallet);
    if (!this.libraryRepository) throw new AdminServiceError("CONFIGURATION_ERROR", 503);
    const notes: string[] = [];
    if (typeof input.enabled === "boolean") {
      try {
        this.libraryRepository.upsertAccountEnabled(wallet, input.enabled, "STUDENT", this.now());
        notes.push(input.enabled ? "mở khóa dịch vụ" : "tạm khóa dịch vụ");
      } catch {
        throw new AdminServiceError("ACCOUNT_UPDATE_FAILED", 409);
      }
    }
    let releasedHolds = 0;
    if (input.releaseHolds) {
      releasedHolds = this.libraryRepository.releaseActiveHolds(wallet, this.now());
      notes.push(`gỡ ${releasedHolds} Library hold`);
    }
    const audit = this.repository.recordAudit({
      action: "UPDATE_STUDENT_ACCESS",
      target: wallet,
      summary: notes.length ? `Cập nhật quyền truy cập ${wallet}: ${notes.join(", ")}` : `Kiểm tra quyền truy cập ${wallet}`,
      status: "DONE",
      createdAt: this.now(),
    });
    return { student: await this.inspectStudent(wallet), releasedHolds, audit };
  }

  async mintSbt(input: {
    wallet: string;
    expiresAt: number;
    replaceExisting?: boolean;
  }): Promise<{ wallet: string; txHashes: string[]; audit: AdminAuditEntry }> {
    const wallet = normalizeAddress(input.wallet);
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0 || BigInt(input.expiresAt) > MAX_UINT64) {
      throw new AdminServiceError("INVALID_EXPIRY", 400);
    }
    const core = this.deployedCore();
    if (!core) throw new AdminServiceError("DEPLOYMENT_NOT_CONFIGURED", 503);
    const key = this.requireSignerKey("sbtIssuer", core.roles.sbtIssuer);
    const rpc = this.requireRpc();
    const onChain = await this.readOnChainStudentState(wallet);
    const block = await rpc.latestBlock();
    const minTs = block?.timestamp ?? this.now();
    if (input.expiresAt <= minTs) throw new AdminServiceError("EXPIRY_MUST_BE_FUTURE", 400);

    const txHashes: string[] = [];
    try {
      if (onChain.sbtTokenId && onChain.sbtTokenId !== "0") {
        if (!input.replaceExisting) throw new AdminServiceError("SBT_ALREADY_ISSUED", 409);
        const revokeSent = await rpc.sendSignedTransaction({
          privateKey: key,
          to: core.contracts.StudentSBTIdentity.address,
          data: SBT_IFACE.encodeFunctionData("revoke", [BigInt(onChain.sbtTokenId)]),
        });
        txHashes.push(revokeSent.txHash);
        // Wait for revoke to mine before estimating gas for mint against latest chain state.
        if (rpc.waitForReceipt) {
          const waited = await rpc.waitForReceipt(revokeSent.txHash, 8_000);
          if (waited.status === "FAILED") throw new AdminServiceError("TX_SIMULATION_FAILED", 422);
          if (waited.status !== "CONFIRMED") throw new AdminServiceError("SBT_REVOKE_PENDING", 409);
        }
      }
      const mintSent = await rpc.sendSignedTransaction({
        privateKey: key,
        to: core.contracts.StudentSBTIdentity.address,
        data: SBT_IFACE.encodeFunctionData("mint", [wallet, BigInt(input.expiresAt)]),
      });
      txHashes.push(mintSent.txHash);
    } catch (error) {
      this.normalizeChainError(error);
    }

    const audit = this.repository.recordAudit({
      action: "MINT_SBT",
      target: wallet,
      summary: `Cấp thẻ sinh viên SBT (-10%) cho ${wallet}, hạn ${new Date(input.expiresAt * 1000).toISOString()}`,
      txHash: txHashes.at(-1) ?? null,
      status: "SUBMITTED",
      createdAt: this.now(),
    });
    return { wallet, txHashes, audit };
  }

  async revokeSbt(rawWallet: string): Promise<{ wallet: string; tokenId: string; txHash: string; audit: AdminAuditEntry }> {
    const wallet = normalizeAddress(rawWallet);
    const core = this.deployedCore();
    if (!core) throw new AdminServiceError("DEPLOYMENT_NOT_CONFIGURED", 503);
    const key = this.requireSignerKey("sbtIssuer", core.roles.sbtIssuer);
    const rpc = this.requireRpc();
    const onChain = await this.readOnChainStudentState(wallet);
    if (!onChain.sbtTokenId || onChain.sbtTokenId === "0") {
      throw new AdminServiceError("SBT_NOT_FOUND", 404);
    }
    let txHash: string;
    try {
      const sent = await rpc.sendSignedTransaction({
        privateKey: key,
        to: core.contracts.StudentSBTIdentity.address,
        data: SBT_IFACE.encodeFunctionData("revoke", [BigInt(onChain.sbtTokenId)]),
      });
      txHash = sent.txHash;
    } catch (error) {
      this.normalizeChainError(error);
    }
    const audit = this.repository.recordAudit({
      action: "REVOKE_SBT",
      target: wallet,
      summary: `Thu hồi thẻ SBT #${onChain.sbtTokenId} của ${wallet}`,
      txHash,
      status: "SUBMITTED",
      createdAt: this.now(),
    });
    return { wallet, tokenId: onChain.sbtTokenId, txHash, audit };
  }

  async fundTestCampus(input: { wallet: string; amountWei: string }): Promise<{ wallet: string; amountWei: string; txHash: string; audit: AdminAuditEntry }> {
    const wallet = normalizeAddress(input.wallet);
    const amountWei = normalizePositiveWei(input.amountWei);
    const key = this.requireSignerKey("funder");
    const rpc = this.requireRpc();
    let txHash: string;
    try {
      const sent = await rpc.sendSignedTransaction({
        privateKey: key,
        to: wallet,
        data: "0x",
        valueWei: amountWei,
      });
      txHash = sent.txHash;
    } catch (error) {
      this.normalizeChainError(error);
    }
    const audit = this.repository.recordAudit({
      action: "FUND_TEST_CAMPUS",
      target: wallet,
      summary: `Chuyển ${amountWei.toString()} wei CAMPUS test tới ${wallet}`,
      txHash,
      status: "SUBMITTED",
      createdAt: this.now(),
    });
    return { wallet, amountWei: amountWei.toString(), txHash, audit };
  }

  async reviewScholarship(input: {
    wallet: string;
    approve: boolean;
    category?: "MERIT" | "SUPPORT";
    reason?: string;
    autoApproveStudent?: boolean;
  }): Promise<{ student: AdminStudentRecord; audit: AdminAuditEntry }> {
    const wallet = normalizeAddress(input.wallet);
    if (!this.campusRepository) throw new AdminServiceError("CONFIGURATION_ERROR", 503);
    if (input.approve && input.autoApproveStudent) {
      const profile = this.campusRepository.profile(wallet);
      if (profile.application?.status !== "APPROVED") {
        this.campusRepository.adminReviewStudent("admin-console", wallet, true, {});
        if (this.libraryRepository) {
          const existing = this.libraryRepository.accountForWallet(wallet);
          if (!existing) this.libraryRepository.enrollVerifiedStudent(wallet);
          else if (existing.role === "STUDENT" && !existing.enabled) this.libraryRepository.setAccountEnabled(wallet, true, this.now());
        }
      }
    }
    try {
      this.campusRepository.adminReviewScholarship("admin-console", wallet, input.approve, {
        category: input.category,
        reason: input.reason,
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "CONFLICT";
      const status = error && typeof error === "object" && "httpStatus" in error ? Number(error.httpStatus) : 409;
      throw new AdminServiceError(code, status);
    }
    const audit = this.repository.recordAudit({
      action: input.approve ? "APPROVE_SCHOLARSHIP" : "REJECT_SCHOLARSHIP",
      target: wallet,
      summary: input.approve
        ? `Duyệt hồ sơ học bổng FOOD (${input.category ?? "SUPPORT"}) cho ${wallet}`
        : `Từ chối hồ sơ học bổng FOOD cho ${wallet}`,
      status: "DONE",
      createdAt: this.now(),
    });
    return { student: await this.inspectStudent(wallet), audit };
  }

  async issueFoodGrant(input: {
    wallet: string;
    amountWei: string;
    markScholarshipApproved?: boolean;
  }): Promise<{ wallet: string; amountWei: string; txHash: string; audit: AdminAuditEntry }> {
    const wallet = normalizeAddress(input.wallet);
    const amountWei = normalizePositiveWei(input.amountWei);
    const core = this.deployedCore();
    if (!core) throw new AdminServiceError("DEPLOYMENT_NOT_CONFIGURED", 503);
    if (same(wallet, core.contracts.PurposeBoundGrantVault.address)) {
      throw new AdminServiceError("INVALID_BENEFICIARY", 400);
    }
    const key = this.requireSignerKey("grantIssuer", core.roles.grantIssuer);
    const rpc = this.requireRpc();
    let txHash: string;
    try {
      const sent = await rpc.sendSignedTransaction({
        privateKey: key,
        to: core.contracts.PurposeBoundGrantVault.address,
        data: VAULT_IFACE.encodeFunctionData("grant", [wallet, FOOD_CATEGORY]),
        valueWei: amountWei,
      });
      txHash = sent.txHash;
    } catch (error) {
      this.normalizeChainError(error);
    }
    if (input.markScholarshipApproved && this.campusRepository) {
      const profile = this.campusRepository.profile(wallet);
      if (profile.application?.status === "APPROVED" && profile.scholarship?.status !== "APPROVED") {
        this.campusRepository.adminReviewScholarship("admin-console", wallet, true, {});
      }
    }
    const audit = this.repository.recordAudit({
      action: "ISSUE_FOOD_GRANT",
      target: wallet,
      summary: `Giải ngân học bổng FOOD (${amountWei.toString()} wei) vào vault cho ${wallet}`,
      txHash,
      status: "SUBMITTED",
      createdAt: this.now(),
    });
    return { wallet, amountWei: amountWei.toString(), txHash, audit };
  }

  async getTransactionStatus(txHash: string): Promise<AdminTxStatus> {
    if (!HASH_RE.test(txHash) || /^0x0{64}$/i.test(txHash)) {
      throw new AdminServiceError("INVALID_HASH", 400);
    }
    const rpc = this.requireRpc();
    let status: AdminTxStatus;
    try {
      status = await rpc.getTransactionStatus(txHash);
    } catch (error) {
      this.normalizeChainError(error);
    }
    if (status.status === "CONFIRMED" || status.status === "FAILED") {
      this.repository.updateAuditByTxHash(txHash, status.status, status.status === "FAILED" ? "TX_REVERTED" : null);
    }
    return status;
  }

  listAudit(limit = 50): AdminAuditEntry[] {
    return this.repository.listAudit(limit);
  }
}
