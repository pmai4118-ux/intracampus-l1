import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { Interface, Wallet, id, keccak256 } from "ethers";
import { CAMPUS_CHAIN_ID, type DeployedLibraryDeployment, type DeployedManifest } from "@intracampus/network";
import baseManifest from "../../deployments/intracampus.json" with { type: "json" };
import libraryFixture from "../../docs/fixtures/library-v1.json" with { type: "json" };
import { createApp } from "../src/app.ts";
import { readAdminConfig } from "../src/modules/admin/admin.config.ts";
import { AdminRepository } from "../src/modules/admin/admin.repository.ts";
import { AdminService } from "../src/modules/admin/admin.service.ts";
import type { AdminRpcClient } from "../src/modules/admin/admin.signer.ts";
import { CampusRepository } from "../src/modules/campus/campus.repository.ts";
import { LibraryRepository } from "../src/modules/library/library.repository.ts";
import { LibraryReceiptVerifier } from "../src/modules/library/library.verifier.ts";
import type { LibraryRpcClient } from "../src/modules/library/library.rpc.ts";

const ORIGIN = "https://intracampus.example.vercel.app";
const ACCESS_KEY = "team-secret-fixed-key-2026";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

const registrySigner = new Wallet("0x0000000000000000000000000000000000000000000000000000000000000011");
const sbtSigner = new Wallet("0x0000000000000000000000000000000000000000000000000000000000000012");
const grantSigner = new Wallet("0x0000000000000000000000000000000000000000000000000000000000000013");
const funderSigner = new Wallet("0x0000000000000000000000000000000000000000000000000000000000000014");

const PARKING_DEFAULT = addr(0x2001);
const CANTEEN_DEFAULT = addr(0x2002);
const LIB_TREASURY_DEFAULT = addr(0x2003);
const LIB_LIBRARIAN_DEFAULT = addr(0x2004);
const STUDENT_SEED = addr(0x3001);

function buildDeployment(legacyLibraryAbi = false): DeployedManifest & { library: DeployedLibraryDeployment } {
  const abi = legacyLibraryAbi
    ? libraryFixture.abi.filter((entry) => !["setTreasury", "setLibrarian", "TreasuryUpdated", "LibrarianUpdated"].includes(String(entry.name ?? "")))
    : libraryFixture.abi;
  return {
    schemaVersion: 1,
    status: "deployed",
    chainId: CAMPUS_CHAIN_ID,
    abiVersion: 1,
    environment: "avalanche-l1",
    contracts: {
      StudentSBTIdentity: {
        address: addr(0x101), abiVersion: 1, abi: baseManifest.contracts.StudentSBTIdentity.abi,
        transactionHash: hash(1), blockNumber: 1, blockHash: hash(101), runtimeCodeHash: hash(201),
      },
      CampusPaymentRegistry: {
        address: addr(0x102), abiVersion: 1, abi: baseManifest.contracts.CampusPaymentRegistry.abi,
        transactionHash: hash(2), blockNumber: 2, blockHash: hash(102), runtimeCodeHash: hash(202),
      },
      PurposeBoundGrantVault: {
        address: addr(0x103), abiVersion: 1, abi: baseManifest.contracts.PurposeBoundGrantVault.abi,
        transactionHash: hash(3), blockNumber: 3, blockHash: hash(103), runtimeCodeHash: hash(203),
      },
    },
    roles: {
      deployer: registrySigner.address,
      sbtIssuer: sbtSigner.address,
      grantIssuer: grantSigner.address,
      posSigner: addr(0x150),
    },
    merchants: {
      parking: { address: PARKING_DEFAULT, category: id("PARKING") },
      canteen: { address: CANTEEN_DEFAULT, category: id("FOOD") },
    },
    library: {
      schemaVersion: 1,
      status: "deployed",
      chainId: CAMPUS_CHAIN_ID,
      abiVersion: 1,
      environment: "avalanche-l1",
      verifiedAt: { blockNumber: 8, blockHash: hash(108) },
      escrow: {
        address: addr(0x104), abiVersion: 1, abi,
        transactionHash: hash(4), blockNumber: 4, blockHash: hash(104), runtimeCodeHash: hash(204),
      },
      roles: {
        deployer: registrySigner.address,
        administrator: registrySigner.address,
        librarian: LIB_LIBRARIAN_DEFAULT,
      },
      treasury: LIB_TREASURY_DEFAULT,
      policy: libraryFixture.policy,
      books: [{ bookId: hash(0xaaa), depositWei: libraryFixture.policy.depositWei, replacementPriceWei: "30000000000000000000", sealed: true }],
      seedTransactions: [
        { type: "seedBookTerms", bookId: hash(0xaaa), transactionHash: hash(5), blockNumber: 5, blockHash: hash(105) },
        { type: "sealBookTerms", bookId: hash(0xaaa), transactionHash: hash(6), blockNumber: 6, blockHash: hash(106) },
      ],
    },
  };
}

class FakeAdminRpc implements AdminRpcClient {
  blockNumber = 20;
  blockTimestamp = 1_800_000_000;
  balances = new Map<string, bigint>();
  allowed = new Map<string, boolean>();
  sbt = new Map<string, { tokenId: bigint; expiresAt: bigint; tier: number }>();
  foodGrants = new Map<string, bigint>();
  libraryTreasury = LIB_TREASURY_DEFAULT;
  libraryLibrarian = LIB_LIBRARIAN_DEFAULT;
  sent: Array<{ from: string; to: string; data: string; valueWei: bigint; txHash: string }> = [];
  txStatuses = new Map<string, "SUBMITTED" | "CONFIRMED" | "FAILED">();
  private nextTx = 1;

  private readonly regIface = new Interface([
    "function allowedMerchantCategories(address,bytes32) view returns (bool)",
    "function setMerchantCategory(address,bytes32,bool)",
  ]);
  private readonly sbtIface = new Interface([
    "function credentials(address) view returns (uint256,uint64)",
    "function tierOf(address) view returns (uint8)",
    "function mint(address,uint64) returns (uint256)",
    "function revoke(uint256)",
  ]);
  private readonly vaultIface = new Interface([
    "function balances(address,bytes32) view returns (uint256)",
    "function grant(address,bytes32) payable",
  ]);
  private readonly escrowIface = new Interface([
    "function treasury() view returns (address)",
    "function librarian() view returns (address)",
    "function setTreasury(address)",
    "function setLibrarian(address)",
  ]);

  constructor() {
    this.allowed.set(`${PARKING_DEFAULT.toLowerCase()}:${id("PARKING")}`, true);
    this.allowed.set(`${CANTEEN_DEFAULT.toLowerCase()}:${id("FOOD")}`, true);
  }

  async chainId() { return BigInt(CAMPUS_CHAIN_ID); }
  async latestBlock() { return { number: this.blockNumber, timestamp: this.blockTimestamp }; }
  async getBalance(address: string) { return this.balances.get(address.toLowerCase()) ?? 1000n * 10n ** 18n; }

  async call(to: string, data: string): Promise<string> {
    const lowerTo = to.toLowerCase();
    if (lowerTo === addr(0x102).toLowerCase()) {
      const [merchant, category] = this.regIface.decodeFunctionData("allowedMerchantCategories", data);
      const ok = this.allowed.get(`${String(merchant).toLowerCase()}:${String(category).toLowerCase()}`) ?? false;
      return this.regIface.encodeFunctionResult("allowedMerchantCategories", [ok]);
    }
    if (lowerTo === addr(0x101).toLowerCase()) {
      if (data.startsWith(this.sbtIface.getFunction("credentials")!.selector)) {
        const [wallet] = this.sbtIface.decodeFunctionData("credentials", data);
        const rec = this.sbt.get(String(wallet).toLowerCase()) ?? { tokenId: 0n, expiresAt: 0n, tier: 0 };
        return this.sbtIface.encodeFunctionResult("credentials", [rec.tokenId, rec.expiresAt]);
      }
      const [wallet] = this.sbtIface.decodeFunctionData("tierOf", data);
      const rec = this.sbt.get(String(wallet).toLowerCase()) ?? { tokenId: 0n, expiresAt: 0n, tier: 0 };
      return this.sbtIface.encodeFunctionResult("tierOf", [rec.tier]);
    }
    if (lowerTo === addr(0x103).toLowerCase()) {
      const [wallet] = this.vaultIface.decodeFunctionData("balances", data);
      return this.vaultIface.encodeFunctionResult("balances", [this.foodGrants.get(String(wallet).toLowerCase()) ?? 0n]);
    }
    if (lowerTo === addr(0x104).toLowerCase()) {
      if (data === this.escrowIface.encodeFunctionData("treasury")) {
        return this.escrowIface.encodeFunctionResult("treasury", [this.libraryTreasury]);
      }
      if (data === this.escrowIface.encodeFunctionData("librarian")) {
        return this.escrowIface.encodeFunctionResult("librarian", [this.libraryLibrarian]);
      }
    }
    return "0x";
  }

  async sendSignedTransaction(input: { privateKey: string; to: string; data: string; valueWei?: bigint }) {
    const from = new Wallet(input.privateKey).address;
    const txHash = hash(0x5000 + this.nextTx++);
    const valueWei = input.valueWei ?? 0n;
    this.sent.push({ from, to: input.to, data: input.data, valueWei, txHash });
    this.txStatuses.set(txHash, "SUBMITTED");

    const lowerTo = input.to.toLowerCase();
    if (lowerTo === addr(0x102).toLowerCase()) {
      const [merchant, category, allowed] = this.regIface.decodeFunctionData("setMerchantCategory", input.data);
      this.allowed.set(`${String(merchant).toLowerCase()}:${String(category).toLowerCase()}`, Boolean(allowed));
    } else if (lowerTo === addr(0x104).toLowerCase()) {
      if (input.data.startsWith(this.escrowIface.getFunction("setTreasury")!.selector)) {
        const [next] = this.escrowIface.decodeFunctionData("setTreasury", input.data);
        this.libraryTreasury = String(next);
      } else if (input.data.startsWith(this.escrowIface.getFunction("setLibrarian")!.selector)) {
        const [next] = this.escrowIface.decodeFunctionData("setLibrarian", input.data);
        this.libraryLibrarian = String(next);
      }
    } else if (lowerTo === addr(0x101).toLowerCase()) {
      if (input.data.startsWith(this.sbtIface.getFunction("mint")!.selector)) {
        const [wallet, expiresAt] = this.sbtIface.decodeFunctionData("mint", input.data);
        this.sbt.set(String(wallet).toLowerCase(), { tokenId: BigInt(this.nextTx), expiresAt: BigInt(expiresAt), tier: 1 });
      } else if (input.data.startsWith(this.sbtIface.getFunction("revoke")!.selector)) {
        const [tokenId] = this.sbtIface.decodeFunctionData("revoke", input.data);
        for (const [wallet, rec] of this.sbt.entries()) {
          if (rec.tokenId === BigInt(tokenId)) this.sbt.delete(wallet);
        }
      }
    } else if (lowerTo === addr(0x103).toLowerCase()) {
      const [wallet] = this.vaultIface.decodeFunctionData("grant", input.data);
      const prev = this.foodGrants.get(String(wallet).toLowerCase()) ?? 0n;
      this.foodGrants.set(String(wallet).toLowerCase(), prev + valueWei);
    } else {
      const prev = this.balances.get(lowerTo) ?? 0n;
      this.balances.set(lowerTo, prev + valueWei);
    }
    return { txHash, from };
  }

  async getTransactionStatus(txHash: string) {
    const status = this.txStatuses.get(txHash.toLowerCase()) ?? "SUBMITTED";
    return {
      txHash: txHash.toLowerCase(),
      status,
      blockNumber: status === "SUBMITTED" ? null : this.blockNumber,
      blockHash: status === "SUBMITTED" ? null : hash(900),
    };
  }

  async waitForReceipt(txHash: string) {
    const lower = txHash.toLowerCase();
    this.txStatuses.set(lower, "CONFIRMED");
    return this.getTransactionStatus(lower);
  }
}

async function setupServer(t: TestContext, options: { legacyLibraryAbi?: boolean; maxLogin?: number } = {}) {
  const adminRepo = new AdminRepository(":memory:");
  const libraryRepo = new LibraryRepository(":memory:");
  const campusRepo = new CampusRepository(":memory:");
  libraryRepo.seedDemo({
    version: 1,
    books: [{
      bookId: hash(0xaaa), title: "Sách thử", author: "Tác giả", isbn: null,
      depositWei: libraryFixture.policy.depositWei, replacementPriceWei: "30000000000000000000",
      copies: [{ copyId: "copy-1", barcode: "BC-1" }],
    }],
    accounts: [
      { wallet: STUDENT_SEED, role: "STUDENT" },
      { wallet: LIB_LIBRARIAN_DEFAULT, role: "LIBRARIAN" },
    ],
  });
  const rpc = new FakeAdminRpc();
  const config = readAdminConfig({
    ADMIN_ACCESS_KEY: ACCESS_KEY,
    ADMIN_AUTH_ORIGIN: ORIGIN,
    ADMIN_LOGIN_RATE_LIMIT_MAX_REQUESTS: String(options.maxLogin ?? 12),
    ADMIN_LOGIN_RATE_LIMIT_WINDOW_SECONDS: "60",
    ADMIN_REGISTRY_SIGNER_PRIVATE_KEY: registrySigner.privateKey,
    ADMIN_LIBRARY_SIGNER_PRIVATE_KEY: registrySigner.privateKey,
    ADMIN_SBT_ISSUER_PRIVATE_KEY: sbtSigner.privateKey,
    ADMIN_GRANT_ISSUER_PRIVATE_KEY: grantSigner.privateKey,
    ADMIN_FUNDER_PRIVATE_KEY: funderSigner.privateKey,
  });
  const service = new AdminService({
    config,
    repository: adminRepo,
    libraryRepository: libraryRepo,
    campusRepository: campusRepo,
    rpc,
    deployment: buildDeployment(options.legacyLibraryAbi),
    now: () => 1_800_000_000,
  });
  const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, libraryRepo, service);
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  t.after(() => {
    server.close();
    service.close();
    adminRepo.close();
    libraryRepo.close();
    campusRepo.close();
  });
  return { baseUrl: `http://127.0.0.1:${port}`, adminRepo, libraryRepo, campusRepo, rpc, service };
}

test("readAdminConfig ignores non-key legacy SEED_* values unless explicit ADMIN_* signer key is invalid", () => {
  const cfg = readAdminConfig({
    ADMIN_ACCESS_KEY: ACCESS_KEY,
    ADMIN_AUTH_ORIGIN: ORIGIN,
    SEED_FUNDER_PRIVATE_KEY: "0x1111111111111111111111111111111111111111",
    SEED_GRANT_ISSUER_PRIVATE_KEY: grantSigner.privateKey,
  });
  assert.equal(cfg.signers.funder, undefined);
  assert.equal(cfg.signers.grantIssuer, grantSigner.privateKey);
  assert.throws(() => readAdminConfig({
    ADMIN_ACCESS_KEY: ACCESS_KEY,
    ADMIN_AUTH_ORIGIN: ORIGIN,
    ADMIN_FUNDER_PRIVATE_KEY: "0x1111111111111111111111111111111111111111",
  }), /INVALID_ADMIN_SIGNER_KEY/);
});

test("fixed-key login enforces Origin, wrong key, rate limits and supports multi-device sessions", async (t) => {
  const { baseUrl } = await setupServer(t, { maxLogin: 3 });

  // Wrong origin rejected.
  const badOrigin = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example.com" },
    body: JSON.stringify({ key: ACCESS_KEY }),
  });
  assert.equal(badOrigin.status, 403);

  // Wrong key returns 401.
  const badKey = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ key: "wrong-key" }),
  });
  assert.equal(badKey.status, 401);

  // Two different machines login concurrently with the same fixed key.
  const loginA = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ key: ACCESS_KEY }),
  });
  assert.equal(loginA.status, 200);
  const cookieA = loginA.headers.get("set-cookie")!.split(";")[0];
  assert.match(cookieA, /^__Host-admin_session=/);

  const loginB = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ key: ACCESS_KEY }),
  });
  assert.equal(loginB.status, 200);
  const cookieB = loginB.headers.get("set-cookie")!.split(";")[0];
  assert.notEqual(cookieA, cookieB);

  // 4th attempt in same window hits rate limit (maxLogin = 3).
  const limited = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ key: ACCESS_KEY }),
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);

  // Both machine sessions read overview; logging out A keeps B valid.
  assert.equal((await fetch(`${baseUrl}/api/admin/overview`, { headers: { cookie: cookieA } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/admin/overview`, { headers: { cookie: cookieB } })).status, 200);

  await fetch(`${baseUrl}/api/admin/auth/logout`, { method: "POST", headers: { origin: ORIGIN, cookie: cookieA } });
  assert.equal((await fetch(`${baseUrl}/api/admin/overview`, { headers: { cookie: cookieA } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/admin/overview`, { headers: { cookie: cookieB } })).status, 200);
});

test("admin updates parking, canteen, library treasury & librarian wallets and exposes public runtime config", async (t) => {
  const { baseUrl, libraryRepo, rpc, service } = await setupServer(t);
  const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ key: ACCESS_KEY }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const headers = { "content-type": "application/json", origin: ORIGIN, cookie };

  const newParking = addr(0x4001);
  const newCanteen = addr(0x4002);
  const newTreasury = addr(0x4003);
  const newLibrarian = addr(0x4004);

  const pRes = await fetch(`${baseUrl}/api/admin/wallets/merchant`, {
    method: "POST", headers, body: JSON.stringify({ kind: "PARKING", address: newParking, revokePrevious: true }),
  });
  assert.equal(pRes.status, 202);
  assert.equal(service.activeParkingMerchant()?.toLowerCase(), newParking.toLowerCase());
  assert.equal(libraryRepo.accountForWallet(newParking)?.role, "PARKING");
  assert.equal(rpc.allowed.get(`${newParking.toLowerCase()}:${id("PARKING")}`), true);
  assert.equal(rpc.allowed.get(`${PARKING_DEFAULT.toLowerCase()}:${id("PARKING")}`), false);

  const cRes = await fetch(`${baseUrl}/api/admin/wallets/merchant`, {
    method: "POST", headers, body: JSON.stringify({ kind: "FOOD", address: newCanteen, revokePrevious: false }),
  });
  assert.equal(cRes.status, 202);
  assert.equal(service.activeCanteenMerchant()?.toLowerCase(), newCanteen.toLowerCase());

  const tRes = await fetch(`${baseUrl}/api/admin/wallets/library-treasury`, {
    method: "POST", headers, body: JSON.stringify({ address: newTreasury }),
  });
  assert.equal(tRes.status, 202);

  const lRes = await fetch(`${baseUrl}/api/admin/wallets/library-librarian`, {
    method: "POST", headers, body: JSON.stringify({ address: newLibrarian }),
  });
  assert.equal(lRes.status, 202);
  assert.equal(libraryRepo.accountForWallet(newLibrarian)?.role, "LIBRARIAN");
  assert.equal(libraryRepo.accountForWallet(newLibrarian)?.enabled, true);
  assert.equal(libraryRepo.accountForWallet(LIB_LIBRARIAN_DEFAULT)?.enabled, false);

  // Public runtime config requires no admin session and reflects all updated wallets.
  const runtimeRes = await fetch(`${baseUrl}/api/config/runtime`);
  assert.equal(runtimeRes.status, 200);
  const runtime = await runtimeRes.json();
  assert.equal(runtime.parkingMerchant.toLowerCase(), newParking.toLowerCase());
  assert.equal(runtime.canteenMerchant.toLowerCase(), newCanteen.toLowerCase());
  assert.equal(runtime.libraryTreasury.toLowerCase(), newTreasury.toLowerCase());
  assert.equal(runtime.libraryLibrarian.toLowerCase(), newLibrarian.toLowerCase());
});

test("legacy LibraryDepositEscrow ABI fails closed with ESCROW_UPGRADE_REQUIRED for treasury/librarian updates", async (t) => {
  const { baseUrl } = await setupServer(t, { legacyLibraryAbi: true });
  const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ key: ACCESS_KEY }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const headers = { "content-type": "application/json", origin: ORIGIN, cookie };

  const res = await fetch(`${baseUrl}/api/admin/wallets/library-treasury`, {
    method: "POST", headers, body: JSON.stringify({ address: addr(0x4099) }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "ESCROW_UPGRADE_REQUIRED");
});

test("admin approves student, manages SBT mint/replace/revoke, issues FOOD grant and polls tx receipts", async (t) => {
  const { baseUrl, rpc } = await setupServer(t);
  const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ key: ACCESS_KEY }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const headers = { "content-type": "application/json", origin: ORIGIN, cookie };
  const freshStudent = addr(0x7001);

  const reviewRes = await fetch(`${baseUrl}/api/admin/students/review`, {
    method: "POST", headers,
    body: JSON.stringify({ wallet: freshStudent, approve: true, studentCode: "SV2026-99", program: "Kỹ thuật phần mềm" }),
  });
  assert.equal(reviewRes.status, 200);
  const reviewed = await reviewRes.json();
  assert.equal(reviewed.student.application.status, "APPROVED");
  assert.equal(reviewed.student.libraryAccount.enabled, true);

  // Mint SBT
  const mintRes = await fetch(`${baseUrl}/api/admin/students/${freshStudent}/sbt/mint`, {
    method: "POST", headers,
    body: JSON.stringify({ expiresAt: 1_810_000_000 }),
  });
  assert.equal(mintRes.status, 202);
  const minted = await mintRes.json();
  assert.equal(minted.txHashes.length, 1);

  // Duplicate mint without replaceExisting rejected with 409
  const dupMint = await fetch(`${baseUrl}/api/admin/students/${freshStudent}/sbt/mint`, {
    method: "POST", headers,
    body: JSON.stringify({ expiresAt: 1_820_000_000 }),
  });
  assert.equal(dupMint.status, 409);

  // Replace existing SBT revokes old token, waits for confirmation, then mints new token
  const replaceMint = await fetch(`${baseUrl}/api/admin/students/${freshStudent}/sbt/mint`, {
    method: "POST", headers,
    body: JSON.stringify({ expiresAt: 1_825_000_000, replaceExisting: true }),
  });
  assert.equal(replaceMint.status, 202);
  const replaced = await replaceMint.json();
  assert.equal(replaced.txHashes.length, 2);

  // Issue FOOD grant & confirm via tx polling
  const grantWei = (1000n * 10n ** 18n).toString();
  const grantRes = await fetch(`${baseUrl}/api/admin/scholarships/grant`, {
    method: "POST", headers,
    body: JSON.stringify({ wallet: freshStudent, amountWei: grantWei }),
  });
  assert.equal(grantRes.status, 202);
  const granted = await grantRes.json();
  rpc.txStatuses.set(granted.txHash, "CONFIRMED");

  const pollRes = await fetch(`${baseUrl}/api/admin/tx/${granted.txHash}`, { headers: { cookie } });
  assert.equal(pollRes.status, 200);
  assert.equal((await pollRes.json()).status, "CONFIRMED");

  const inspected = await (await fetch(`${baseUrl}/api/admin/students/${freshStudent}`, { headers: { cookie } })).json();
  assert.equal(inspected.student.onChain.sbtTier, 1);
  assert.equal(inspected.student.onChain.foodGrantBalanceWei, grantWei);
  assert.equal(inspected.student.scholarship.status, "APPROVED");
});

test("LibraryReceiptVerifier verifies historical LoanApproved using librarian() at log.blockNumber after rotation", async () => {
  const deployment = buildDeployment(false).library;
  const escrowAddr = deployment.escrow.address;
  const iface = new Interface(deployment.escrow.abi);
  const oldLibrarian = LIB_LIBRARIAN_DEFAULT;
  const newLibrarian = addr(0x8888);
  const reqId = hash(0x91);
  const borrower = STUDENT_SEED;
  const approvedAt = 1_800_000_100;
  const dueAt = approvedAt + deployment.policy.loanDurationSeconds;
  const txHash = hash(0x92);
  const blockHash = hash(0x93);
  const logFragment = iface.getEvent("LoanApproved")!;
  const encoded = iface.encodeEventLog(logFragment, [reqId, borrower, approvedAt, dueAt, 30n * 10n ** 18n]);

  const fakeRpc: LibraryRpcClient = {
    async getNetwork() { return { chainId: BigInt(CAMPUS_CHAIN_ID) }; },
    async getBlock(tag) { return { number: Number(tag), hash: blockHash, timestamp: approvedAt } as never; },
    async getLogs() { return []; },
    async getTransaction() {
      return {
        hash: txHash,
        from: oldLibrarian,
        to: escrowAddr,
        data: iface.encodeFunctionData("approve", [reqId]),
        value: 0n,
      } as never;
    },
    async getTransactionReceipt() {
      return {
        hash: txHash,
        status: 1,
        blockNumber: 10,
        blockHash,
        to: escrowAddr,
        logs: [{ address: escrowAddr, topics: encoded.topics, data: encoded.data, index: 0, transactionHash: txHash }],
      } as never;
    },
    async getCode() { return "0x6000"; },
    async call(_tx, blockTag) {
      // At block 10 the librarian was oldLibrarian; at block 20 it rotated to newLibrarian.
      const who = (blockTag ?? 20) < 20 ? oldLibrarian : newLibrarian;
      return iface.encodeFunctionResult("librarian", [who]);
    },
  };

  const verifier = new LibraryReceiptVerifier(fakeRpc, { ...deployment, roles: { ...deployment.roles, librarian: newLibrarian } });
  const verified = await verifier.verify(
    { address: escrowAddr, blockNumber: 10, blockHash, transactionHash: txHash, index: 0, removed: false, topics: encoded.topics, data: encoded.data } as never,
    25,
    approvedAt + 5,
  );
  assert.equal(verified?.eventName, "LoanApproved");
  assert.equal(verified?.transactionFrom, oldLibrarian.toLowerCase());
});
