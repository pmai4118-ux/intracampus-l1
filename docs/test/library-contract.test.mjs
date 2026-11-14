import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Interface } from "ethers";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/library-v1.json", import.meta.url), "utf8"));
const librarySource = new URL("../scope.md", import.meta.url);
const demoSource = new URL("../demo-flow.md", import.meta.url);

const DEPOSIT = 50_000_000_000_000_000_000n;
const DAY = 86_400;
const E18 = 1_000_000_000_000_000_000n;

function normalizedAbiEntry(entry) {
  const signature = `${entry.name ?? "constructor"}(${(entry.inputs ?? []).map(({ type }) => type).join(",")})`;
  const inputs = (entry.inputs ?? []).map(({ name = "", type, indexed }) => `${name}:${type}${indexed ? ":indexed" : ""}`).join("|");
  const outputs = (entry.outputs ?? []).map(({ name = "", type }) => `${name}:${type}`).join("|") || "-";
  if (entry.type === "constructor") return `constructor ${signature}:${entry.stateMutability}:inputs(${inputs})`;
  if (entry.type === "function") return `function ${signature}:${entry.stateMutability}:inputs(${inputs}):outputs(${outputs})`;
  if (entry.type === "event") return `event ${signature}:anonymous=${entry.anonymous ?? false}:inputs(${inputs})`;
  if (entry.type === "error") return `error ${signature}:inputs(${inputs})`;
  return `${entry.type} ${signature}`;
}

const EXPECTED_ABI_SURFACE = [
  "constructor constructor(address,address,address):nonpayable:inputs(administrator_:address|librarian_:address|treasury_:address)",
  "function seedBookTerms(bytes32,uint256,uint256):nonpayable:inputs(bookId:bytes32|depositWei:uint256|replacementPriceWei:uint256):outputs(-)",
  "function sealBookTerms(bytes32):nonpayable:inputs(bookId:bytes32):outputs(-)",
  "function bookTerms(bytes32):view:inputs(bookId:bytes32):outputs(depositWei:uint256|replacementPriceWei:uint256|sealed:bool)",
  "function deposit(bytes32,bytes32):payable:inputs(requestId:bytes32|bookId:bytes32):outputs(-)",
  "function approve(bytes32):nonpayable:inputs(requestId:bytes32):outputs(-)",
  "function reject(bytes32):nonpayable:inputs(requestId:bytes32):outputs(-)",
  "function claimExpiredRefund(bytes32):nonpayable:inputs(requestId:bytes32):outputs(-)",
  "function settleReturn(bytes32,uint256):nonpayable:inputs(requestId:bytes32|repairRequestedWei:uint256):outputs(-)",
  "function settleLost(bytes32):nonpayable:inputs(requestId:bytes32):outputs(-)",
  "function payShortfall(bytes32):payable:inputs(requestId:bytes32):outputs(-)",
  "function requestInfo(bytes32):view:inputs(requestId:bytes32):outputs(borrower:address|bookId:bytes32|depositWei:uint256|replacementPriceWei:uint256|depositedAt:uint64|approvedAt:uint64|dueAt:uint64|state:uint8|shortfallWei:uint256)",
  "function administrator():view:inputs():outputs(:address)",
  "function librarian():view:inputs():outputs(:address)",
  "function treasury():view:inputs():outputs(:address)",
  "function APPROVAL_WINDOW():view:inputs():outputs(:uint64)",
  "function LOAN_DURATION():view:inputs():outputs(:uint64)",
  "function GRACE_PERIOD():view:inputs():outputs(:uint64)",
  "function LATE_FEE_INTERVAL():view:inputs():outputs(:uint64)",
  "function LATE_FEE_PER_INTERVAL():view:inputs():outputs(:uint256)",
  "function MAX_LATE_FEE():view:inputs():outputs(:uint256)",
  "function FULL_DEPOSIT_RETENTION_AFTER():view:inputs():outputs(:uint64)",
  "event DepositReceived(bytes32,address,bytes32,uint256,uint64):anonymous=false:inputs(requestId:bytes32:indexed|borrower:address:indexed|bookId:bytes32:indexed|amount:uint256|depositedAt:uint64)",
  "event LoanApproved(bytes32,address,uint64,uint64,uint256):anonymous=false:inputs(requestId:bytes32:indexed|borrower:address:indexed|approvedAt:uint64|dueAt:uint64|replacementPriceWei:uint256)",
  "event RequestRejected(bytes32,address,uint256):anonymous=false:inputs(requestId:bytes32:indexed|borrower:address:indexed|refundWei:uint256)",
  "event ExpiredRefundClaimed(bytes32,address,uint256):anonymous=false:inputs(requestId:bytes32:indexed|borrower:address:indexed|refundWei:uint256)",
  "event ReturnSettled(bytes32,address,uint64,uint256,uint256,uint256,uint256,uint256,bool):anonymous=false:inputs(requestId:bytes32:indexed|borrower:address:indexed|returnedAt:uint64|lateFeeWei:uint256|repairFeeWei:uint256|overdueForfeitWei:uint256|totalRetainedWei:uint256|refundWei:uint256|maintenanceRequired:bool)",
  "event LostSettled(bytes32,address,uint256,uint256,uint256,uint256):anonymous=false:inputs(requestId:bytes32:indexed|borrower:address:indexed|replacementPriceWei:uint256|retainedWei:uint256|refundWei:uint256|shortfallWei:uint256)",
  "event ShortfallPaid(bytes32,address,uint256):anonymous=false:inputs(requestId:bytes32:indexed|borrower:address:indexed|amount:uint256)",
  "event BookTermsSeeded(bytes32,uint256,uint256):anonymous=false:inputs(bookId:bytes32:indexed|depositWei:uint256|replacementPriceWei:uint256)",
  "event BookTermsSealed(bytes32):anonymous=false:inputs(bookId:bytes32:indexed)",
  "error InvalidConfiguration():inputs()",
  "error UnauthorizedAdministrator():inputs()",
  "error UnauthorizedLibrarian():inputs()",
  "error UnauthorizedBorrower():inputs()",
  "error InvalidBookTerms():inputs()",
  "error BookTermsAlreadySealed(bytes32):inputs(bookId:bytes32)",
  "error BookTermsNotSealed(bytes32):inputs(bookId:bytes32)",
  "error RequestAlreadyUsed(bytes32):inputs(requestId:bytes32)",
  "error RequestNotFound(bytes32):inputs(requestId:bytes32)",
  "error InvalidRequestState(bytes32,uint8):inputs(requestId:bytes32|state:uint8)",
  "error ApprovalWindowExpired(uint64):inputs(deadline:uint64)",
  "error ApprovalWindowOpen(uint64):inputs(deadline:uint64)",
  "error InvalidPayment(uint256,uint256):inputs(expectedWei:uint256|receivedWei:uint256)",
  "error TransferFailed(address,uint256):inputs(recipient:address|amountWei:uint256)",
  "error ReentrantCall():inputs()",
].sort();

function getPath(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

function setPath(object, path, value) {
  const parts = path.split(".");
  const leaf = parts.pop();
  const parent = parts.reduce((target, key) => target[key] ??= {}, object);
  parent[leaf] = value;
}

function runtimeConfigViolations(config) {
  return Object.entries(fixture.runtimeConfig?.requiredSettings ?? {})
    .filter(([path, rule]) => {
      const value = getPath(config, path);
      if (!Number.isSafeInteger(value)) return true;
      return rule.domain === "positiveSafeInteger" ? value < 1 : value < 0;
    })
    .map(([path]) => path);
}

 test("pins CAMPUS chain, deposit and policy durations", () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.network.chainId, 20261);
  assert.equal(fixture.network.nativeCurrency.decimals, 18);
  assert.equal(fixture.policy.depositWei, DEPOSIT.toString());
  assert.equal(fixture.policy.approvalWindowSeconds, DAY);
  assert.equal(fixture.policy.loanDurationSeconds, 14 * DAY);
  assert.equal(fixture.policy.gracePeriodSeconds, 3 * DAY);
  assert.equal(fixture.policy.lateFeeIntervalSeconds, DAY);
  assert.equal(fixture.policy.lateFeePerIntervalWei, (E18 / 10n).toString());
  assert.equal(fixture.policy.maxLateFeeWei, (25n * E18).toString());
  assert.equal(fixture.policy.fullDepositRetentionAfterSeconds, 30 * DAY);
  assert.equal(fixture.policy.approvalComparison, "<");
  assert.equal(fixture.policy.refundAtDeadlineComparison, ">=");
  assert.equal(fixture.policy.requestIdNeverReusable, true);
  assert.equal(fixture.policy.loanIdEqualsRequestId, true);
  const expiry = fixture.transitions?.find((item) => item.event === "ApprovalDeadlineReached");
  assert.equal(expiry?.copyStatus, "RELEASED");
  assert.equal(expiry?.refundStatus, "REFUND_DUE");
});

test("deposit confirmation cannot create an active loan", () => {
  const deposited = fixture.transitions?.find((item) => item.event === "DepositReceived");
  const approved = fixture.transitions?.find((item) => item.event === "LoanApproved");
  assert.equal(deposited?.requestStatus, "PENDING_APPROVAL");
  assert.equal(deposited?.loanStatus, "NONE");
  assert.equal(approved?.loanStatus, "ACTIVE");
  assert.equal(fixture.states?.loan?.includes("ACTIVE"), true);
  assert.equal(fixture.policy.approveBeforeDeadlineOnly, true);
  assert.deepEqual(fixture.states?.escrowStateCodes, { NONE: 0, DEPOSITED: 1, ACTIVE: 2, REFUNDED: 3, RETURN_SETTLED: 4, LOST_SHORTFALL_DUE: 5, LOST_SETTLED: 6 });
});

test("ABI exposes only the agreed request-keyed escrow actions and proof events", () => {
  const contract = new Interface(fixture.abi ?? []);
  assert.deepEqual((fixture.abi ?? []).map(normalizedAbiEntry).sort(), EXPECTED_ABI_SURFACE);
  const unapprovedFunction = { type: "function", name: "withdrawAll", inputs: [], outputs: [], stateMutability: "nonpayable" };
  assert.throws(() => assert.deepEqual([...fixture.abi, unapprovedFunction].map(normalizedAbiEntry).sort(), EXPECTED_ABI_SURFACE));
  const anonymousMutation = structuredClone(fixture.abi);
  anonymousMutation.find(({ type, name }) => type === "event" && name === "DepositReceived").anonymous = true;
  assert.throws(() => assert.deepEqual(anonymousMutation.map(normalizedAbiEntry).sort(), EXPECTED_ABI_SURFACE));
  const renamedFieldMutation = structuredClone(fixture.abi);
  renamedFieldMutation.find(({ type, name }) => type === "event" && name === "ReturnSettled").inputs.find(({ name }) => name === "lateFeeWei").name = "penaltyWei";
  assert.throws(() => assert.deepEqual(renamedFieldMutation.map(normalizedAbiEntry).sort(), EXPECTED_ABI_SURFACE));
  for (const signature of [
    "seedBookTerms(bytes32,uint256,uint256)",
    "sealBookTerms(bytes32)",
    "deposit(bytes32,bytes32)",
    "approve(bytes32)",
    "reject(bytes32)",
    "claimExpiredRefund(bytes32)",
    "settleReturn(bytes32,uint256)",
    "settleLost(bytes32)",
    "payShortfall(bytes32)",
    "requestInfo(bytes32)",
  ]) assert.ok(contract.getFunction(signature), `missing ${signature}`);
  for (const signature of [
    "DepositReceived(bytes32,address,bytes32,uint256,uint64)",
    "LoanApproved(bytes32,address,uint64,uint64,uint256)",
    "RequestRejected(bytes32,address,uint256)",
    "ExpiredRefundClaimed(bytes32,address,uint256)",
    "ReturnSettled(bytes32,address,uint64,uint256,uint256,uint256,uint256,uint256,bool)",
    "LostSettled(bytes32,address,uint256,uint256,uint256,uint256)",
    "ShortfallPaid(bytes32,address,uint256)",
  ]) assert.ok(contract.getEvent(signature), `missing ${signature}`);
  assert.deepEqual(contract.getEvent("DepositReceived").inputs.filter((input) => input.indexed).map((input) => input.name), ["requestId", "borrower", "bookId"]);
  assert.deepEqual(contract.getEvent("ReturnSettled").inputs.filter((input) => input.indexed).map((input) => input.name), ["requestId", "borrower"]);
});

test("late-return and lost-book vectors preserve exact boundary arithmetic", () => {
  assert.equal(fixture.returnVectors?.length, 8);
  for (const vector of fixture.returnVectors ?? []) {
    const elapsed = vector.elapsedSinceDueSeconds;
    const lateIntervals = Math.floor(Math.max(0, elapsed - 3 * DAY) / DAY);
    const calculatedLate = BigInt(lateIntervals) * (E18 / 10n);
    const late = calculatedLate > 25n * E18 ? 25n * E18 : calculatedLate;
    const repair = BigInt(vector.repairRequestedWei);
    const overdue = elapsed > 30 * DAY;
    const retained = overdue ? DEPOSIT : [DEPOSIT, late + repair].reduce((a, b) => a < b ? a : b);
    assert.equal(late.toString(), vector.expectedLateFeeWei, vector.name);
    assert.equal(retained.toString(), vector.expectedRetainedWei, vector.name);
    assert.equal((DEPOSIT - retained).toString(), vector.expectedRefundWei, vector.name);
    assert.equal(overdue, vector.expectedOverdue, vector.name);
  }
  const cappedRepair = fixture.returnVectors.find(({ name }) => name === "repair plus one late fee exceeds deposit by 0.05");
  assert.ok(cappedRepair, "missing repair-plus-late deposit-cap boundary vector");
  assert.ok(BigInt(cappedRepair.expectedLateFeeWei) + BigInt(cappedRepair.repairRequestedWei) > DEPOSIT);
  assert.equal(cappedRepair.expectedRetainedWei, DEPOSIT.toString());
  assert.equal(cappedRepair.expectedRefundWei, "0");
  assert.equal(fixture.lostVectors?.length, 3);
  for (const vector of fixture.lostVectors ?? []) {
    const replacement = BigInt(vector.replacementPriceWei);
    const retained = replacement < DEPOSIT ? replacement : DEPOSIT;
    const refund = DEPOSIT - retained;
    const shortfall = replacement > DEPOSIT ? replacement - DEPOSIT : 0n;
    assert.equal(retained.toString(), vector.expectedRetainedWei, vector.name);
    assert.equal(refund.toString(), vector.expectedRefundWei, vector.name);
    assert.equal(shortfall.toString(), vector.expectedShortfallWei, vector.name);
    assert.equal(vector.appliesLateFee, false);
  }
});

test("API keeps role and price authority on the server", () => {
  const routes = new Set((fixture.api?.endpoints ?? []).map(({ method, path }) => `${method} ${path}`));
  for (const route of [
    "POST /api/auth/challenge", "POST /api/auth/verify", "GET /api/auth/session", "POST /api/auth/logout",
    "GET /api/library/books", "GET /api/library/requests", "POST /api/library/requests",
    "GET /api/library/requests/:requestId", "POST /api/library/requests/:requestId/transactions",
    "GET /api/library/loans", "POST /api/library/loans/:loanId/return-requests",
    "POST /api/library/loans/:loanId/settlement-intents", "GET /api/library/account-status",
  ]) assert.ok(routes.has(route), `missing ${route}`);
  assert.deepEqual(fixture.api?.createRequestFields, ["bookId", "idempotencyKey"]);
  assert.deepEqual(fixture.api?.transactionActions, ["deposit", "approve", "reject", "refund", "return", "settle", "payShortfall"]);
  assert.equal(fixture.api?.roleFromClient, false);
  assert.equal(fixture.api?.priceFromClient, false);
  assert.equal(fixture.api?.noCopyBeforeVerifiedDeposit, true);
  assert.deepEqual(fixture.api?.errorStatuses, { VALIDATION_ERROR: 400, PAYLOAD_TOO_LARGE: 413, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, RPC_UNAVAILABLE: 503, WRONG_CHAIN: 503, STALE_CHAIN_STATE: 503, DATABASE_BUSY: 503, CONFIGURATION_ERROR: 503, INTERNAL_ERROR: 500 });
  assert.equal(fixture.api?.loanFilterParameter, "borrowerWallet");
  assert.equal(fixture.api?.loanFilterRole, "LIBRARIAN");
  assert.deepEqual(fixture.api?.transactionActionMethods, { deposit: "deposit", approve: "approve", reject: "reject", refund: "claimExpiredRefund", return: "settleReturn", settle: "settleLost", payShortfall: "payShortfall" });
  assert.deepEqual(fixture.api?.transactionActionRoles, { deposit: "STUDENT_OWNER", approve: "LIBRARIAN", reject: "LIBRARIAN", refund: "STUDENT_OWNER", return: "LIBRARIAN", settle: "LIBRARIAN", payShortfall: "STUDENT_OWNER" });
  assert.equal(fixture.api?.idempotency?.keyScopedToBorrower, true);
  assert.equal(fixture.api?.idempotency?.sameKeySameBookReturnsExisting, true);
  assert.equal(fixture.api?.idempotency?.sameKeyDifferentBookConflicts, true);
});

test("Library JSON bodies share the existing 8 KiB invoice parser limit", () => {
  assert.deepEqual(fixture.api?.requestBodyLimit, {
    bytes: 8192,
    source: "backend/src/modules/invoices/invoices.routes.ts express.json({ limit: '8kb' })",
    appliesTo: "all Library JSON POST routes",
    overLimit: { status: 413, code: "PAYLOAD_TOO_LARGE" },
  });
  const vectors = fixture.api?.requestBodyLimitVectors ?? [];
  assert.deepEqual(vectors.map(({ sizeBytes }) => sizeBytes), [8191, 8192, 8193]);
  for (const vector of vectors) {
    const parserAccepts = vector.sizeBytes <= fixture.api.requestBodyLimit.bytes;
    assert.equal(vector.parserOutcome, parserAccepts ? "ACCEPT" : "REJECT", vector.name);
    assert.equal(vector.status, parserAccepts ? null : 413, vector.name);
  }
});

test("deposit action maps producer, receipt consumer, persistence and its acceptance oracle", () => {
  const deposit = fixture.callerMatrix?.deposit;
  assert.ok(deposit?.producer);
  assert.ok(deposit?.contractConsumer);
  assert.ok(deposit?.backendConsumer);
  assert.ok(deposit?.persistence?.length);
  assert.ok(deposit?.verification);
  assert.equal(deposit?.successTransition, "matching verified receipt and allocated copy => PENDING_APPROVAL / loan NONE");
});

test("approval deadline vectors release the copy at the boundary independently of refund claim", () => {
  const vectors = fixture.approvalDeadlineVectors ?? [];
  assert.deepEqual(vectors.map(({ secondsFromDeadline }) => secondsFromDeadline), [-1, 0, 1]);
  for (const vector of vectors) {
    const beforeDeadline = vector.secondsFromDeadline < 0;
    assert.equal(vector.approvalAllowed, beforeDeadline, vector.name);
    assert.equal(vector.refundClaimAllowed, !beforeDeadline, vector.name);
    assert.equal(vector.copyStatus, beforeDeadline ? "HELD" : "RELEASED", vector.name);
    if (beforeDeadline) continue;
    assert.equal(vector.requestStatus, "EXPIRED_REFUND_DUE", vector.name);
    assert.equal(vector.loanStatus, "NONE", vector.name);
    assert.equal(vector.refundStatus, "REFUND_DUE", vector.name);
    assert.equal(vector.refundClaimed, false, vector.name);
  }
});

test("required runtime config keys, units and fail-closed domains are explicit", () => {
  const schema = fixture.runtimeConfig;
  assert.equal(schema?.source, "operator-environment");
  assert.equal(schema?.productionDefaults, null);
  assert.deepEqual(schema?.missingOrInvalid, { status: 503, code: "CONFIGURATION_ERROR" });
  const settings = schema?.requiredSettings ?? {};
  assert.deepEqual(Object.keys(settings).sort(), [
    "chainFreshness.maxFutureDriftSeconds",
    "chainFreshness.maxStaleSeconds",
    "chainFreshness.minConfirmations",
    "challengeRateLimit.maxRequests",
    "challengeRateLimit.windowSeconds",
    "challengeTtlSeconds",
    "sessionTtlSeconds",
    "verifyRateLimit.maxRequests",
    "verifyRateLimit.windowSeconds",
  ]);
  for (const [path, rule] of Object.entries(settings)) {
    assert.ok(["positiveSafeInteger", "nonnegativeSafeInteger"].includes(rule.domain), path);
    assert.ok(rule.unit, path);
  }

  const validConfig = {};
  for (const [path, rule] of Object.entries(settings)) {
    setPath(validConfig, path, rule.domain === "positiveSafeInteger" ? 1 : 0);
  }
  assert.deepEqual(runtimeConfigViolations(validConfig), []);
  for (const [path, rule] of Object.entries(settings)) {
    const missing = structuredClone(validConfig);
    const parts = path.split(".");
    const leaf = parts.pop();
    const parent = parts.reduce((target, key) => target[key], missing);
    delete parent[leaf];
    assert.ok(runtimeConfigViolations(missing).includes(path), `${path} must be required`);

    const invalid = structuredClone(validConfig);
    setPath(invalid, path, rule.domain === "positiveSafeInteger" ? 0 : -1);
    assert.ok(runtimeConfigViolations(invalid).includes(path), `${path} must enforce its domain`);
  }
});

test("settlement preview response and every transaction action have a typed caller handoff", () => {
  assert.deepEqual(fixture.api?.settlementIntentResponseFields, [
    "requestId", "loanId", "outcome", "borrower", "chainId", "escrow", "treasury",
    "walletCall.to", "walletCall.data", "walletCall.valueWei", "preview", "chainTime",
  ]);
  assert.deepEqual(fixture.api?.settlementIntentPreviewFields, [
    "RETURNED.returnedAt", "RETURNED.lateFeeWei", "RETURNED.repairFeeWei", "RETURNED.overdueForfeitWei",
    "RETURNED.totalRetainedWei", "RETURNED.refundWei", "RETURNED.maintenanceRequired",
    "LOST.replacementPriceWei", "LOST.totalRetainedWei", "LOST.refundWei", "LOST.shortfallWei",
  ]);
  assert.ok(fixture.api?.loanResponseFields?.includes("borrower"));
  const actions = fixture.api?.transactionActions ?? [];
  assert.deepEqual(Object.keys(fixture.callerMatrix ?? {}).sort(), [...actions].sort());
  for (const action of actions) {
    const handoff = fixture.callerMatrix[action];
    for (const field of ["producer", "endpoint", "contractConsumer", "backendConsumer", "verifiedProof", "persistence", "successTransition", "verification"]) {
      assert.ok(handoff?.[field], `${action} is missing ${field}`);
    }
  }
});
