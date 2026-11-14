import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LibraryRepository } from "../src/modules/library/library.repository.ts";
import type { LibraryDemoSeed, LibraryVerifiedChainEvent } from "../src/modules/library/library.types.ts";

const student = "0x1111111111111111111111111111111111111111";
const librarian = "0x2222222222222222222222222222222222222222";
const bookId = `0x${"ab".repeat(32)}`;
const depositWei = "50000000000000000000";
const priceWei = "30000000000000000000";
const retentionSeconds = 2_592_000;

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "library-holds-"));
  const path = join(directory, "library.sqlite");
  const repository = new LibraryRepository(path);
  repository.seedDemo({
    version: 1,
    books: [{ bookId, title: "Hold test book", author: "Test author", isbn: null, depositWei,
      replacementPriceWei: priceWei, copies: [
        { copyId: "copy-001", barcode: "LH-001" }, { copyId: "copy-002", barcode: "LH-002" },
      ] }],
    accounts: [{ wallet: student, role: "STUDENT" }, { wallet: librarian, role: "LIBRARIAN" }],
  } satisfies LibraryDemoSeed);
  return { repository, cleanup: () => { repository.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("overdue admission uses the strict retention boundary and blocks under the write lock after it", (t) => {
  const { repository, cleanup } = setup();
  t.after(cleanup);

  const historicalRequestId = `0x${"31".repeat(32)}`;
  const depositedAt = 1_700_000_000;
  const approvedAt = depositedAt + 1;
  const dueAt = approvedAt + 1_209_600;
  repository.createDepositRequest({ requestId: historicalRequestId, wallet: student, bookId,
    idempotencyKey: "historical-loan", createdAt: depositedAt - 1, chainTime: depositedAt - 1,
    holdAfterSeconds: retentionSeconds });
  const common = { chainId: 20261 as const, contractAddress: "0x4444444444444444444444444444444444444444",
    logIndex: 0, observedAt: 1_800_000_000 };
  const deposit: LibraryVerifiedChainEvent = { ...common, txHash: `0x${"41".repeat(32)}`, blockNumber: 10,
    blockHash: `0x${"51".repeat(32)}`, blockTimestamp: depositedAt, transactionFrom: student,
    eventName: "DepositReceived", requestId: historicalRequestId, borrower: student, bookId, amountWei: depositWei,
    depositedAt, approvalDeadline: depositedAt + 86_400 };
  repository.recordVerifiedChainEvents([deposit], 10, 1_800_000_000, "{}");
  const approval: LibraryVerifiedChainEvent = { ...common, txHash: `0x${"42".repeat(32)}`, blockNumber: 11,
    blockHash: `0x${"52".repeat(32)}`, blockTimestamp: approvedAt, transactionFrom: librarian,
    eventName: "LoanApproved", requestId: historicalRequestId, borrower: student, approvedAt, dueAt,
    replacementPriceWei: priceWei };
  repository.recordVerifiedChainEvents([approval], 11, 1_800_000_000, "{}");

  const boundary = dueAt + retentionSeconds;
  const atBoundaryId = `0x${"32".repeat(32)}`;
  const admitted = repository.createDepositRequest({ requestId: atBoundaryId, wallet: student, bookId,
    idempotencyKey: "at-retention-boundary", createdAt: boundary, chainTime: boundary,
    holdAfterSeconds: retentionSeconds });
  assert.equal(admitted.status, "AWAITING_DEPOSIT");
  assert.deepEqual(repository.accountStatus(student, boundary, retentionSeconds), {
    held: false, checkedAt: boundary, blockingLoanIds: [],
  });

  const afterBoundaryId = `0x${"33".repeat(32)}`;
  assert.throws(() => repository.createDepositRequest({ requestId: afterBoundaryId, wallet: student, bookId,
    idempotencyKey: "after-retention-boundary", createdAt: boundary + 1, chainTime: boundary + 1,
    holdAfterSeconds: retentionSeconds }), { message: "LIBRARY_ACCOUNT_HELD" });
  assert.equal(repository.getRequest(afterBoundaryId), undefined);
  assert.deepEqual(repository.accountStatus(student, boundary + 1, retentionSeconds), {
    held: true, checkedAt: boundary + 1, blockingLoanIds: [historicalRequestId],
  });
});

test("overdue hold remains through physical return review and releases only on verified settlement", (t) => {
  const { repository, cleanup } = setup();
  t.after(cleanup);
  const requestId = `0x${"34".repeat(32)}`;
  const depositedAt = 1_700_000_000, approvedAt = depositedAt + 1;
  const dueAt = approvedAt + 1_209_600, returnAt = dueAt + retentionSeconds + 1;
  const common = { chainId: 20261 as const, contractAddress: "0x4444444444444444444444444444444444444444",
    logIndex: 0, observedAt: returnAt };
  repository.createDepositRequest({ requestId, wallet: student, bookId, idempotencyKey: "overdue-return-settlement",
    createdAt: depositedAt - 1, chainTime: depositedAt - 1, holdAfterSeconds: retentionSeconds });
  repository.recordVerifiedChainEvents([{
    ...common, txHash: `0x${"71".repeat(32)}`, blockNumber: 10, blockHash: `0x${"81".repeat(32)}`,
    blockTimestamp: depositedAt, transactionFrom: student, eventName: "DepositReceived", requestId, borrower: student,
    bookId, amountWei: depositWei, depositedAt, approvalDeadline: depositedAt + 86_400,
  }], 10, returnAt, "{}");
  repository.recordVerifiedChainEvents([{
    ...common, txHash: `0x${"72".repeat(32)}`, blockNumber: 11, blockHash: `0x${"82".repeat(32)}`,
    blockTimestamp: approvedAt, transactionFrom: librarian, eventName: "LoanApproved", requestId, borrower: student,
    approvedAt, dueAt, replacementPriceWei: priceWei,
  }], 11, returnAt, "{}");
  assert.equal(repository.accountStatus(student, returnAt, retentionSeconds).held, true);

  const requested = repository.requestReturn({ loanId: requestId, wallet: student, requestedAt: returnAt });
  repository.recordVerifiedChainEvents([{
    ...common, txHash: `0x${"73".repeat(32)}`, blockNumber: 12, blockHash: `0x${"83".repeat(32)}`,
    blockTimestamp: returnAt, transactionFrom: librarian, eventName: "PhysicalReturnConfirmed", requestId, borrower: student,
    returnedAt: returnAt,
  }], 12, returnAt, "{}");
  assert.equal(repository.getRequest(requestId)?.status, "SETTLEMENT_PENDING");
  assert.equal(repository.accountStatus(student, returnAt, retentionSeconds).held, true,
    "physical receipt must not clear the hold while refund/forfeit remains unsettled");
  assert.deepEqual(repository.requestReturn({ loanId: requestId, wallet: student, requestedAt: returnAt + 10 }), requested,
    "retries return the original request after physical return has advanced the loan state");

  repository.createSettlementIntent({ intentId: "return-settlement-1", loanId: requestId, librarianWallet: librarian,
    outcome: "RETURNED", condition: "GOOD", reason: "Verified overdue return", repairRequestedWei: "0", createdAt: returnAt });
  repository.recordVerifiedChainEvents([{
    ...common, txHash: `0x${"74".repeat(32)}`, blockNumber: 13, blockHash: `0x${"84".repeat(32)}`,
    blockTimestamp: returnAt + 1, transactionFrom: librarian, eventName: "ReturnSettled", requestId, borrower: student,
    returnedAt: returnAt, lateFeeWei: "0", repairFeeWei: "0", overdueForfeitWei: depositWei,
    totalRetainedWei: depositWei, refundWei: "0", maintenanceRequired: false,
  }], 13, returnAt + 1, "{}");
  assert.equal(repository.getRequest(requestId)?.status, "RETURNED");
  assert.equal(repository.accountStatus(student, returnAt + 1, retentionSeconds).held, false,
    "the overdue hold releases after the verified settlement transition");
  assert.deepEqual(repository.requestReturn({ loanId: requestId, wallet: student, requestedAt: returnAt + 20 }), requested,
    "the original return request remains idempotent after settlement");
});
