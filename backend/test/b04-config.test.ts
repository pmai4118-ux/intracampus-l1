import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Wallet } from "ethers";
import { readInvoiceCreationConfig } from "../src/modules/invoices/invoice.config.ts";
import { InvoiceCreationService } from "../src/modules/invoices/invoices.service.ts";
import { SqliteInvoiceRepository } from "../src/modules/invoices/invoices.repository.ts";

// Structural config tests only: this copied local manifest is not L1 evidence.
const manifest = JSON.parse(readFileSync(new URL("../../docs/fixtures/b03-l05-l06-local.json", import.meta.url), "utf8")).manifest;
manifest.environment = "avalanche-l1";
const wallet = Wallet.fromPhrase("test test test test test test test test test test test junk");
manifest.roles.posSigner = wallet.address;
const env = { POS_SIGNER_PRIVATE_KEY: wallet.privateKey };
const other = `0x${"12".repeat(20)}`;
test("B04 invoice creation uses canonical merchant and roles, rejects conflicting overrides", () => {
  const config = readInvoiceCreationConfig(env, manifest);
  assert.equal(config.merchant, manifest.merchants.parking.address);
  assert.equal(config.expectedSigner, manifest.roles.posSigner);
  assert.equal(config.studentSbt, manifest.contracts.StudentSBTIdentity.address);
  assert.throws(() => readInvoiceCreationConfig({ ...env, PARKING_MERCHANT_ADDRESS: other }, manifest), /canonical L06/);
  assert.equal(readInvoiceCreationConfig({ ...env, PARKING_MERCHANT_ADDRESS: config.merchant?.toUpperCase().replace("0X", "0x") }, manifest).merchant, config.merchant);
  assert.deepEqual(readInvoiceCreationConfig({ PARKING_MERCHANT_ADDRESS: other }, { schemaVersion: 1, abiVersion: 1, chainId: 20261, status: "unconfigured" }), { merchant: other, privateKey: undefined });
});
test("B04 canonical invoice rejects wrong signer, SBT or disabled merchant before persisting", async () => {
  for (const bad of ["signer", "sbt", "merchant", null]) {
    const repository = new SqliteInvoiceRepository(":memory:");
    let calls = 0;
    const config = readInvoiceCreationConfig(env, manifest);
    if (bad === "signer") config.expectedSigner = other;
    const rpc = { async call(method: string, params: unknown[]) {
      calls++;
      if (method === "eth_chainId") return "0x4f25";
      if (method === "eth_getBlockByNumber") return { number: "0x6", timestamp: "0x6a000000" };
      const data = (params[0] as { data: string }).data;
      if (data.startsWith("0xf06da054")) return `0x${wallet.address.slice(2).toLowerCase().padStart(64, "0")}`;
      // Calls follow the existing same-block signer read.
      if (calls === 4) return `0x${(bad === "sbt" ? other : config.studentSbt!).slice(2).toLowerCase().padStart(64, "0")}`;
      return `0x${(bad === "merchant" ? "0" : "1").padStart(64, "0")}`;
    } };
    const service = new InvoiceCreationService({ repository, rpc, config,
      deployment: { contractAddress: manifest.contracts.CampusPaymentRegistry.address, deploymentBlock: 2 } });
    try {
      if (bad) await assert.rejects(() => service.create({ merchantId: "parking-demo", serviceId: "parking-single" }));
      else assert.equal((await service.create({ merchantId: "parking-demo", serviceId: "parking-single" })).status, "pending");
    } finally { repository.close(); }
  }
});
