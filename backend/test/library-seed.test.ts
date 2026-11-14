import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSeedMatchesDeployment, parseLibrarySeed } from "../scripts/seed-library.ts";
import type { LibraryDemoSeed } from "../src/modules/library/library.types.ts";
import type { requireLibraryDeployment } from "@intracampus/network";

const librarian = "0x3333333333333333333333333333333333333333";
const bookIdA = `0x${"ab".repeat(32)}`;
const bookIdB = `0x${"cd".repeat(32)}`;
const depositWei = "50000000000000000000";
const priceWei = "30000000000000000000";
const seed: LibraryDemoSeed = {
  version: 1,
  books: [{ bookId: bookIdA, title: "Demo", author: "Author", isbn: null, depositWei,
    replacementPriceWei: priceWei, copies: [{ copyId: "c1", barcode: "b1" }] }],
  accounts: [
    { wallet: librarian, role: "LIBRARIAN" },
    { wallet: "0x1111111111111111111111111111111111111111", role: "STUDENT" },
  ],
};
const deployment = {
  library: {
    books: [
      { bookId: bookIdA, depositWei, replacementPriceWei: priceWei, sealed: true },
    ],
    policy: { depositWei },
    roles: { librarian },
  },
} as unknown as ReturnType<typeof requireLibraryDeployment>;

test("demo catalog seed must exactly match sealed deployment terms and librarian", () => {
  assert.doesNotThrow(() => assertSeedMatchesDeployment(seed, deployment));
  assert.throws(() => assertSeedMatchesDeployment({ ...seed, books: [...seed.books, {
    ...seed.books[0], bookId: bookIdB,
  }] }, deployment), { message: "LIBRARY_SEED_BOOK_SET_MISMATCH" });
  assert.throws(() => assertSeedMatchesDeployment({ ...seed, books: [{ ...seed.books[0], replacementPriceWei: "1" }] }, deployment),
    { message: "LIBRARY_SEED_TERMS_MISMATCH" });
  assert.throws(() => assertSeedMatchesDeployment({ ...seed, accounts: [
    { wallet: "0x4444444444444444444444444444444444444444", role: "LIBRARIAN" }, seed.accounts[1],
  ] }, deployment), { message: "LIBRARY_SEED_LIBRARIAN_MISMATCH" });
});

test("seed parser rejects unknown fields that could carry secrets or student identifiers", () => {
  assert.deepEqual(parseLibrarySeed(seed), seed);
  assert.throws(() => parseLibrarySeed({ ...seed, privateKey: "not-accepted" }), { message: "INVALID_LIBRARY_SEED_FILE" });
  assert.throws(() => parseLibrarySeed({ ...seed, accounts: [{ ...seed.accounts[0], studentId: "not-accepted" }, seed.accounts[1]] }),
    { message: "INVALID_LIBRARY_SEED_FILE" });
  assert.throws(() => parseLibrarySeed({ ...seed, books: [{ ...seed.books[0], copies: [{ ...seed.books[0].copies[0], mnemonic: "not-accepted" }] }] }),
    { message: "INVALID_LIBRARY_SEED_FILE" });
});
