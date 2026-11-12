import assert from "node:assert/strict";
import { test } from "node:test";
import evidence from "../../docs/fixtures/b03-l05-l06-local.json" with { type: "json" };
import { readInvoiceDeployment } from "../src/modules/invoices/receipt.config.ts";

// Reuse the complete ABI shape as synthetic config input; no test publishes this as an L1 manifest.
const fixture = () => ({ ...structuredClone(evidence.manifest), environment: "avalanche-l1" });
test("B02 derives verifier and scan block from the canonical shared manifest", () => {
  const data = fixture(); const registry = data.contracts.CampusPaymentRegistry;
  assert.deepEqual(readInvoiceDeployment({}, data), { contractAddress: registry.address, deploymentBlock: registry.blockNumber });
});
test("matching legacy B02 environment is accepted without changing canonical values", () => {
  const data = fixture(); const registry = data.contracts.CampusPaymentRegistry;
  assert.deepEqual(readInvoiceDeployment({ CAMPUS_PAYMENT_REGISTRY_ADDRESS: registry.address.toLowerCase(),
    CAMPUS_PAYMENT_DEPLOYMENT_BLOCK: String(registry.blockNumber) }, data),
  { contractAddress: registry.address.toLowerCase(), deploymentBlock: registry.blockNumber });
});
for (const field of ["address", "block"] as const) test(`conflicting B02 ${field} environment fails closed`, () => {
  const data = fixture(); const registry = data.contracts.CampusPaymentRegistry;
  assert.throws(() => readInvoiceDeployment({ CAMPUS_PAYMENT_REGISTRY_ADDRESS: field === "address" ? data.contracts.StudentSBTIdentity.address : registry.address,
    CAMPUS_PAYMENT_DEPLOYMENT_BLOCK: String(registry.blockNumber + (field === "block" ? 1 : 0)) }, data), /canonical/);
});
test("partial explicit B02 config is rejected even with a complete canonical deployment", () => {
  assert.throws(() => readInvoiceDeployment({ CAMPUS_PAYMENT_REGISTRY_ADDRESS: fixture().contracts.CampusPaymentRegistry.address }, fixture()));
});
test("local Anvil manifest cannot enable production receipt verification", () => {
  assert.throws(() => readInvoiceDeployment({}, evidence.manifest));
});
test("unconfigured development remains available without inventing a verifier", () => {
  assert.equal(readInvoiceDeployment({}, { schemaVersion: 1, abiVersion: 1, chainId: 20261, status: "unconfigured" }), undefined);
});
