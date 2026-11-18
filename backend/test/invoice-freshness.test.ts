import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultInvoiceChainFreshness, isFreshInvoiceChainTimestamp, readInvoiceChainFreshness } from "../src/modules/invoices/chain-freshness.ts";

test("freshness includes both configured boundaries and rejects either outside second", () => {
  const now = 1000000;
  for (const [timestamp, fresh] of [[700, true], [699, false], [1030, true], [1031, false], [1000, true]] as const) {
    assert.equal(isFreshInvoiceChainTimestamp(timestamp, now, defaultInvoiceChainFreshness), fresh);
  }
  for (const timestamp of [-1, NaN, Infinity, 1.5]) assert.equal(isFreshInvoiceChainTimestamp(timestamp, now, defaultInvoiceChainFreshness), false);
});

test("freshness configuration defaults and explicit zero future drift are preserved", () => {
  assert.deepEqual(readInvoiceChainFreshness({}), defaultInvoiceChainFreshness);
  assert.deepEqual(readInvoiceChainFreshness({ INVOICE_CHAIN_MAX_STALE_SECONDS: "60", INVOICE_CHAIN_MAX_FUTURE_DRIFT_SECONDS: "0" }), { maxStaleSeconds: 60, maxFutureDriftSeconds: 0 });
  for (const raw of ["0", "-1", "1.5", "NaN", "9007199254740992"]) assert.throws(() => readInvoiceChainFreshness({ INVOICE_CHAIN_MAX_STALE_SECONDS: raw }));
});
