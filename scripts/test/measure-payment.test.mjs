import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import template from "../../deployments/intracampus.json" with { type: "json" };
import fixture from "../../docs/fixtures/b02-receipt-fixture.json" with { type: "json" };

const hash = n => `0x${n.toString(16).padStart(64, "0")}`;
const address = n => `0x${n.toString(16).padStart(40, "0")}`;
const { envelope, rpcReceipt } = fixture;
const payer = `0x${rpcReceipt.logs[0].topics[2].slice(-40)}`;
const manifest = { ...template, status: "deployed", environment: "local-anvil",
  contracts: Object.fromEntries(Object.entries(template.contracts).map(([name, value], i) => [name, {
    ...value, address: name === "CampusPaymentRegistry" ? envelope.domain.verifyingContract : address(10 + i),
    transactionHash: hash(i + 1), blockHash: hash(i + 100), blockNumber: i + 1, runtimeCodeHash: hash(i + 200),
  }])), roles: { deployer: address(1), sbtIssuer: address(2), grantIssuer: address(3), posSigner: envelope.signer },
  merchants: { parking: { address: envelope.invoice.merchant, category: envelope.invoice.category },
    canteen: { address: address(22), category: "0x2f6f5a261d6f4514c3f09a834720fe583c82f2ee4758ce9a45fbd67428e9f93d" } },
};
function run(change = () => {}) {
  const row = { invoiceId: envelope.invoice.invoiceId, payer, tier: 0, txHash: rpcReceipt.transactionHash,
    observed: "hash-observed", marksMs: { request: 100, hash: 200, receipt: 212, pos: 250 }, envelope,
    rpcReceipt: { ...rpcReceipt, from: payer, to: envelope.domain.verifyingContract }, canonicalBlockHash: rpcReceipt.blockHash };
  const evidence = structuredClone({ schemaVersion: 1, source: "fixture", manifest,
    context: { appCommit: "0".repeat(40), startedAt: "2026-11-13T00:00:00.000Z", network: "test", devices: "test", wallet: "test",
      clock: "test", posPollMs: 2000, receiptPollMs: 50, planned: { standard: 2, sbt: 0 } }, attempts: [row] });
  change(evidence, evidence.attempts[0]);
  const directory = mkdtempSync(join(tmpdir(), "q01-test-"));
  const file = join(directory, "evidence.json");
  try {
    writeFileSync(file, JSON.stringify(evidence));
    const result = spawnSync(process.execPath, ["scripts/measure-payment.ts", "summarize", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally { unlinkSync(file); rmdirSync(directory); }
}

test("recomputes exact CAMPUS fees from raw receipt quantities even past safe integer range", () => {
  const report = run((_e, row) => { row.rpcReceipt.effectiveGasPrice = "0x20000000000001"; });
  assert.equal(report.attempts[0].feeWei, "616272573009378741060");
  assert.equal(report.attempts[0].feeCampus, "616.27257300937874106");
  assert.equal(report.attempts[0].payment.paidAmount, "3000000000000000000000");
});

test("excludes a different verifier, mismatched payer, wrong event and noncanonical receipt", () => {
  for (const mutate of [
    (e) => { e.manifest.contracts.CampusPaymentRegistry.address = address(40); },
    (_e, r) => { r.payer = address(42); },
    (_e, r) => { r.rpcReceipt.logs[0].topics[1] = hash(42); },
    (_e, r) => { r.canonicalBlockHash = hash(42); },
  ]) {
    const report = run(mutate);
    assert.equal(report.attempts[0].status, "receipt-mismatch");
    assert.equal(report.groups.standard.verified, 0);
  }
});

test("keeps duplicate invoices and hashes out of percentiles and counts attempts without a hash", () => {
  const report = run((e, r) => {
    e.attempts.push(structuredClone(r), { invoiceId: hash(9), payer, tier: 0, observed: "rejected", marksMs: { request: 70 } });
  });
  assert.deepEqual(report.attempts.map(row => row.status), ["verified", "duplicate", "rejected"]);
  assert.equal(report.groups.standard.attempted, 3);
  assert.equal(report.groups.standard.verified, 1);
  assert.equal(report.groups.standard.errors, 2);
});

test("uses nearest rank for small samples and leaves unobserved durations absent", () => {
  const report = run((e, r) => {
    const second = structuredClone(r);
    // Same P02 amounts, distinct invoice and event. The fixture invoice ID is tied to its code.
    delete r.marksMs.receipt;
    second.invoiceId = second.envelope.invoice.invoiceId = second.rpcReceipt.logs[0].topics[1] = "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8";
    second.envelope.meta.invoiceCode = "hello";
    second.txHash = second.rpcReceipt.transactionHash = second.rpcReceipt.logs[0].transactionHash = hash(555);
    second.marksMs.pos = 300;
    e.attempts.push(second);
  });
  assert.deepEqual(report.groups.standard.segmentsMs.hashToPos, { n: 2, p50: 50, p95: 100 });
  assert.deepEqual(report.groups.standard.segmentsMs.hashToReceipt, { n: 1, p50: 12, p95: 12 });
  assert.deepEqual(report.groups.standard.segmentsMs.submitToReceipt, { n: 0, p50: null, p95: null });
});

test("a receipt collected after a timeout proves the fee but does not turn the run into a timed success", () => {
  const report = run((_e, r) => { r.observed = "timeout"; delete r.marksMs.pos; });
  assert.equal(report.attempts[0].status, "verified");
  assert.equal(report.groups.standard.errorsByStatus.timeout, 1);
  assert.equal(report.groups.standard.segmentsMs.hashToReceipt.n, 0);
});

test("historical successful and reverted hashes retain fees without inventing timing", () => {
  const ok = run((_e, r) => { r.observed = "historical"; r.marksMs = {}; });
  assert.equal(ok.attempts[0].status, "verified");
  assert.equal(ok.groups.standard.segmentsMs.hashToReceipt.n, 0);
  const reverted = run((_e, r) => { r.observed = "historical"; r.marksMs = {}; r.rpcReceipt.status = "0x0"; r.rpcReceipt.logs = []; });
  assert.equal(reverted.attempts[0].status, "reverted");
  assert.equal(reverted.attempts[0].feeWei, "1710500000000000");
});
