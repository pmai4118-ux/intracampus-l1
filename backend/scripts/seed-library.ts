import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireLibraryDeployment } from "@intracampus/network";
import { LibraryRepository } from "../src/modules/library/library.repository.ts";
import type { LibraryDemoSeed } from "../src/modules/library/library.types.ts";

export class LibrarySeedError extends Error {
  constructor(code: string) { super(code); this.name = "LibrarySeedError"; }
}

export function assertSeedMatchesDeployment(seed: LibraryDemoSeed, deployment: ReturnType<typeof requireLibraryDeployment>): void {
  const library = deployment.library;
  if (seed.books.length !== library.books.length) throw new LibrarySeedError("LIBRARY_SEED_BOOK_SET_MISMATCH");
  const onChainTerms = new Map(library.books.map((book) => [book.bookId.toLowerCase(), book]));
  for (const book of seed.books) {
    const terms = onChainTerms.get(book.bookId.toLowerCase());
    if (!terms || terms.sealed !== true || terms.depositWei !== book.depositWei
      || terms.replacementPriceWei !== book.replacementPriceWei || book.depositWei !== library.policy.depositWei) {
      throw new LibrarySeedError("LIBRARY_SEED_TERMS_MISMATCH");
    }
  }
  const librarians = seed.accounts.filter((account) => account.role === "LIBRARIAN");
  if (librarians.length !== 1 || librarians[0].wallet.toLowerCase() !== library.roles.librarian.toLowerCase()) {
    throw new LibrarySeedError("LIBRARY_SEED_LIBRARIAN_MISMATCH");
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parseLibrarySeed(value: unknown): LibraryDemoSeed {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LibrarySeedError("INVALID_LIBRARY_SEED_FILE");
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ["version", "books", "accounts"])) throw new LibrarySeedError("INVALID_LIBRARY_SEED_FILE");
  const seed = value as Partial<LibraryDemoSeed>;
  if (!Number.isSafeInteger(seed.version) || !Array.isArray(seed.books) || !Array.isArray(seed.accounts)) {
    throw new LibrarySeedError("INVALID_LIBRARY_SEED_FILE");
  }
  for (const book of seed.books) {
    if (!book || typeof book !== "object" || !exactKeys(book as unknown as Record<string, unknown>,
      ["bookId", "title", "author", "isbn", "depositWei", "replacementPriceWei", "copies"]) || !Array.isArray(book.copies)) {
      throw new LibrarySeedError("INVALID_LIBRARY_SEED_FILE");
    }
    for (const copy of book.copies) {
      if (!copy || typeof copy !== "object" || !exactKeys(copy as unknown as Record<string, unknown>, ["copyId", "barcode"])) {
        throw new LibrarySeedError("INVALID_LIBRARY_SEED_FILE");
      }
    }
  }
  for (const account of seed.accounts) {
    if (!account || typeof account !== "object" || !exactKeys(account as unknown as Record<string, unknown>, ["wallet", "role"])) {
      throw new LibrarySeedError("INVALID_LIBRARY_SEED_FILE");
    }
  }
  return seed as LibraryDemoSeed;
}

export async function seedLibrary(options: { seedPath: string; databasePath: string; allowLocal: boolean }): Promise<{ result: "inserted" | "unchanged"; version: number; books: number; copies: number; accounts: number }> {
  const seed = parseLibrarySeed(JSON.parse(await readFile(resolve(options.seedPath), "utf8")));
  const deployment = requireLibraryDeployment(undefined, { allowLocal: options.allowLocal });
  assertSeedMatchesDeployment(seed, deployment);
  const repository = new LibraryRepository(options.databasePath);
  try {
    const result = repository.seedDemo(seed);
    return { result, version: seed.version, books: seed.books.length,
      copies: seed.books.reduce((sum, book) => sum + book.copies.length, 0), accounts: seed.accounts.length };
  } finally { repository.close(); }
}

async function main(): Promise<void> {
  const baseDirectory = dirname(fileURLToPath(import.meta.url));
  const seedPath = process.env.LIBRARY_SEED_FILE?.trim();
  if (!seedPath) throw new LibrarySeedError("LIBRARY_SEED_FILE_REQUIRED");
  const databasePath = process.env.LIBRARY_DB_PATH?.trim() || resolve(baseDirectory, "../data/library.sqlite");
  const allowLocal = process.env.LIBRARY_ALLOW_LOCAL_ANVIL === "true";
  const result = await seedLibrary({ seedPath, databasePath, allowLocal });
  console.log(JSON.stringify({ event: "library-seed", ...result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = error instanceof LibrarySeedError || error instanceof Error && /^LIBRARY_[A-Z_]+$/.test(error.message)
      ? error.message : "LIBRARY_SEED_FAILED_CHECK_DEPLOYMENT_AND_SEED_FILE";
    console.error(JSON.stringify({ event: "error", code }));
    process.exitCode = 1;
  });
}
