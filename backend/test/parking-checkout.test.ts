import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { id, Wallet } from "ethers";
import { createApp } from "../src/app.ts";
import type { LibraryAuthConfig } from "../src/modules/auth/auth.config.ts";
import { AuthRepository } from "../src/modules/auth/auth.repository.ts";
import { AuthService } from "../src/modules/auth/auth.service.ts";
import { SqliteInvoiceRepository } from "../src/modules/invoices/invoices.repository.ts";
import { ReceiptService } from "../src/modules/invoices/receipt.service.ts";
import { LibraryRepository } from "../src/modules/library/library.repository.ts";
import { deployment, envelope, FakeRpc, invoiceId, otherHash } from "./invoices.helpers.ts";

test("students see their open paid tickets and only staff can close a scanned ticket once", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "intracampus-parking-"));
  const database = join(folder, "invoices.sqlite");
  const repo = new SqliteInvoiceRepository(database);
  const library = new LibraryRepository(":memory:");
  const student = new Wallet(`0x${"11".repeat(32)}`);
  const payer = new Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
  const staff = new Wallet(`0x${"33".repeat(32)}`);
  const config: LibraryAuthConfig = {
    origin: "http://127.0.0.1:3000", domain: "127.0.0.1:3000", chainId: 20261,
    challengeTtlSeconds: 300, sessionTtlSeconds: 3600,
    challengeRateLimit: { maxRequests: 10, windowSeconds: 60 },
    verifyRateLimit: { maxRequests: 10, windowSeconds: 60 },
    trustedProxyAddresses: [], cookieName: "library_session", secureCookie: false,
  };
  library.seedDemo({ version: 1, books: [{
    bookId: `0x${"ab".repeat(32)}`, title: "Demo", author: "Demo", isbn: null,
    depositWei: "50000000000000000000", replacementPriceWei: "30000000000000000000",
    copies: [{ copyId: "demo-1", barcode: "DEMO-1" }],
  }], accounts: [
    { wallet: student.address, role: "STUDENT" }, { wallet: payer.address, role: "STUDENT" },
    { wallet: staff.address, role: "LIBRARIAN" },
  ] });
  const auth = new AuthService(new AuthRepository(library), config);
  async function cookie(wallet: Wallet) {
    const challenge = auth.createChallenge({ wallet: wallet.address, remoteAddress: "127.0.0.1" });
    const signature = await wallet.signMessage(challenge.message);
    const { token } = auth.verifyChallenge({ challengeId: challenge.challengeId, signature, remoteAddress: "127.0.0.1" });
    return `${config.cookieName}=${token}`;
  }
  repo.create(envelope);
  const rpc = new FakeRpc();
  const receipts = new ReceiptService({ repository: repo, deployment, rpc });
  const server = createApp(undefined, receipts, undefined, undefined, auth, config, undefined, undefined, repo).listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    library.close();
    repo.close();
    rmSync(folder, { recursive: true });
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/parking`;
  const url = `${base}/${invoiceId}`;
  const headers = { origin: config.origin, cookie: await cookie(staff) };
  const payerCookie = await cookie(payer);
  const otherCookie = await cookie(student);
  const post = (overrides = headers) => fetch(url, { method: "POST", headers: overrides });
  const tickets = (wallet: Wallet, cookie: string) => fetch(`${base}/tickets`, {
    headers: { cookie, "x-campus-wallet": wallet.address },
  });

  assert.equal((await tickets(payer, "")).status, 401);
  assert.deepEqual(await (await tickets(payer, payerCookie)).json(), { tickets: [] });
  assert.equal((await post()).status, 409);
  rpc.settle();
  const paid = (await receipts.lookup(invoiceId)).body;
  assert.ok(paid.receipt);
  assert.equal(paid.receipt.payer.toLowerCase(), payer.address.toLowerCase());
  const nextCode = envelope.meta.invoiceCode + "-NEXT";
  const nextId = id(nextCode);
  repo.create({ ...envelope, meta: { ...envelope.meta, invoiceCode: nextCode },
    invoice: { ...envelope.invoice, invoiceId: nextId } });
  repo.confirm(nextId, { ...repo.get(nextId)!, receipt: {
    ...paid.receipt, invoiceId: nextId, invoiceCode: nextCode, txHash: otherHash, verifiedAt: paid.receipt.verifiedAt + 1,
  } });
  const firstTicket = { invoiceId, invoiceCode: envelope.meta.invoiceCode, checkedInAt: paid.receipt.verifiedAt };
  const nextTicket = { invoiceId: nextId, invoiceCode: nextCode, checkedInAt: paid.receipt.verifiedAt + 1 };
  assert.deepEqual(await (await tickets(payer, payerCookie)).json(), { tickets: [nextTicket, firstTicket] });
  assert.deepEqual(await (await tickets(student, otherCookie)).json(), { tickets: [] });
  assert.equal((await tickets(student, payerCookie)).status, 403);
  assert.equal((await post({ ...headers, cookie: "" })).status, 401);
  assert.equal((await post({ ...headers, cookie: payerCookie })).status, 403);
  assert.equal((await post({ ...headers, origin: "https://other.example" })).status, 403);
  assert.deepEqual(await (await fetch(url)).json(), { invoiceCode: envelope.meta.invoiceCode, checkedOutAt: null });
  const responses = await Promise.all([post(), post()]);
  assert.deepEqual(responses.map((r) => r.status), [200, 200]);
  const [first, second] = await Promise.all(responses.map((r) => r.json()));
  assert.ok(Number.isSafeInteger(first.checkedOutAt) && first.checkedOutAt > 0);
  assert.deepEqual(first, second);
  assert.deepEqual(await (await fetch(url)).json(), first);
  assert.deepEqual(await (await tickets(payer, payerCookie)).json(), { tickets: [nextTicket] });
  const reopened = new SqliteInvoiceRepository(database);
  try { assert.equal(reopened.parkingCheckoutAt(invoiceId), first.checkedOutAt); }
  finally { reopened.close(); }
});
