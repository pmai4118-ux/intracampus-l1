import assert from "node:assert/strict";
import { test } from "node:test";
import { LibraryConfigurationError, readLibraryConfig } from "../src/modules/library/library.config.ts";

const required = {
  INTRACAMPUS_RPC_URL: "https://rpc.example.test/campus",
  LIBRARY_CHAIN_MAX_STALE_SECONDS: "300",
  LIBRARY_CHAIN_MAX_FUTURE_DRIFT_SECONDS: "30",
  LIBRARY_MIN_CONFIRMATIONS: "3",
};

test("Library chain settings require explicit freshness policy and a safe HTTPS endpoint", () => {
  assert.deepEqual(readLibraryConfig(required), {
    rpcUrl: required.INTRACAMPUS_RPC_URL,
    allowLocal: false,
    chainFreshness: { maxStaleSeconds: 300, maxFutureDriftSeconds: 30, minConfirmations: 3 },
  });
  const deployment = { library: "manifest" };
  assert.equal(readLibraryConfig(required, deployment).deployment, deployment,
    "server wiring keeps the trusted deployment manifest with the validated runtime settings");
  assert.deepEqual(readLibraryConfig({ ...required, INTRACAMPUS_RPC_URL: "http://127.0.0.1:8545", LIBRARY_ALLOW_LOCAL_ANVIL: "true" }), {
    rpcUrl: "http://127.0.0.1:8545/",
    allowLocal: true,
    chainFreshness: { maxStaleSeconds: 300, maxFutureDriftSeconds: 30, minConfirmations: 3 },
  });
});

test("Library config fails closed for missing policy, unsafe endpoints, and noncanonical numbers", () => {
  const invalid = [
    {},
    { ...required, INTRACAMPUS_RPC_URL: "http://rpc.example.test" },
    { ...required, INTRACAMPUS_RPC_URL: "https://user:secret@rpc.example.test" },
    { ...required, INTRACAMPUS_RPC_URL: "https://rpc.example.test?token=secret" },
    { ...required, LIBRARY_CHAIN_MAX_STALE_SECONDS: "0" },
    { ...required, LIBRARY_CHAIN_MAX_FUTURE_DRIFT_SECONDS: "01" },
    { ...required, LIBRARY_MIN_CONFIRMATIONS: "9007199254740992" },
    { ...required, LIBRARY_ALLOW_LOCAL_ANVIL: "yes" },
  ];
  for (const input of invalid) assert.throws(() => readLibraryConfig(input), LibraryConfigurationError);
});
