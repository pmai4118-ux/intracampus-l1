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
