import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { walletConfigFromDeployment } from "../lib/chains.ts";
const manifest = JSON.parse(readFileSync(new URL("../../docs/fixtures/b03-l05-l06-local.json", import.meta.url), "utf8")).manifest;
manifest.environment = "avalanche-l1"; // Config validation only, never L1 proof.
test("B04 wallet derives SBT/verifier/signer from L06 and rejects every conflicting override", () => {
  const config = walletConfigFromDeployment({ rpcUrl: "https://rpc.example/rpc" }, manifest);
  assert.equal(config.sbtAddress, manifest.contracts.StudentSBTIdentity.address);
  assert.equal(config.paymentRegistryAddress, manifest.contracts.CampusPaymentRegistry.address);
  assert.equal(config.posSignerAddress, manifest.roles.posSigner);
  for (const key of ["sbtAddress", "paymentRegistryAddress", "posSignerAddress"] as const) {
    assert.throws(() => walletConfigFromDeployment({ ...config, [key]: `0x${"12".repeat(20)}` }, manifest), /canonical L06/);
  }
  assert.deepEqual(walletConfigFromDeployment(config, manifest), config);
  assert.equal(walletConfigFromDeployment({ rpcUrl: "http://127.0.0.1:8545" }, { schemaVersion: 1, abiVersion: 1, chainId: 20261, status: "unconfigured" }).rpcUrl, "http://127.0.0.1:8545");
  assert.throws(() => walletConfigFromDeployment({}, { ...manifest, chainId: 43113 }));
});
