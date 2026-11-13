import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { GrantsService } from "../src/modules/grants/grants.service.ts";
import { beneficiary, rpcFixture, serve } from "./grants-read.helpers.ts";

test("application mounts grants and preserves unavailable deployment as a 503 response", async (t) => {
  const api = await serve(t, createApp());
  const result = await fetch(`${api}/api/grants/${beneficiary}`);
  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { status: "unverified", chainId: 20261, balanceWei: null,
    error: { code: "DEPLOYMENT_NOT_CONFIGURED", retryable: false } });
});
test("application exposes configured grant reader without adding grant or spend mutations", async (t) => {
  const { rpc, provider } = await rpcFixture(t);
  rpc.balance = 4000000000000000000000n;
  const api = await serve(t, createApp(undefined, undefined, undefined, new GrantsService({ provider, deployment: rpc.deployment, allowLocal: true })));
  const response = await fetch(`${api}/api/grants/${beneficiary}`);
  assert.equal(response.status, 200); assert.equal((await response.json()).balanceWei, "4000000000000000000000");
  assert.equal((await fetch(`${api}/api/grants/${beneficiary}`, { method: "POST" })).status, 404);
});
