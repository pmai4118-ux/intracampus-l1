import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, keccak256 } from "ethers";
import { SBT_ABI, createSeedClient, seedDemo, type SeedEvent } from "../scripts/seed-demo.ts";

test("local EVM: seed real L03 bytecode twice with no duplicate transfer or mint", {
  skip: !process.env.ANVIL_BIN || !process.env.SEED_SBT_ARTIFACT,
  timeout: 60_000,
}, async (t) => {
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const endpoint = listener.address();
  assert.ok(endpoint && typeof endpoint !== "string");
  const port = endpoint.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  const anvil = spawn(process.env.ANVIL_BIN!, ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "20261", "--silent"], { stdio: "ignore", windowsHide: true });
  let spawnError: Error | undefined;
  anvil.on("error", (error) => { spawnError = error; });
  t.after(() => { anvil.kill(); });
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  t.after(() => provider.destroy());
  for (let attempt = 0; ; attempt++) {
    if (spawnError) throw spawnError;
    try { await provider.send("eth_chainId", []); break; }
    catch { if (attempt === 30) throw new Error("Local anvil did not start"); await delay(100); }
  }
  const initialSigner = await provider.getSigner(0);
  // Fresh ephemeral secrets exist only inside this test process, never fixtures or logs.
  const funder = Wallet.createRandom().connect(provider);
  const normal = Wallet.createRandom().address;
  const student = Wallet.createRandom().address;
  await (await initialSigner.sendTransaction({ to: funder.address, value: 1000n * 10n ** 18n })).wait();
  const artifact = JSON.parse(await readFile(resolve(process.env.SEED_SBT_ARTIFACT!), "utf8"));
  const sbt = await new ContractFactory(artifact.abi, artifact.bytecode.object, funder).deploy(funder.address);
  await sbt.waitForDeployment();
  const sbtAddress = await sbt.getAddress();
  const now = (await provider.getBlock("latest"))!.timestamp;
  const config = {
    chainId: 20261, funder: funder.address,
    normal: { address: normal, targetBalanceWei: 10n * 10n ** 18n },
    student: { address: student, targetBalanceWei: 10n * 10n ** 18n, expiresAt: BigInt(now + 86400) },
  };
  const previousFunderKey = process.env.SEED_FUNDER_PRIVATE_KEY;
  const previousIssuerKey = process.env.SEED_ISSUER_PRIVATE_KEY;
  t.after(() => {
    if (previousFunderKey === undefined) delete process.env.SEED_FUNDER_PRIVATE_KEY;
    else process.env.SEED_FUNDER_PRIVATE_KEY = previousFunderKey;
    if (previousIssuerKey === undefined) delete process.env.SEED_ISSUER_PRIVATE_KEY;
    else process.env.SEED_ISSUER_PRIVATE_KEY = previousIssuerKey;
  });
  process.env.SEED_FUNDER_PRIVATE_KEY = funder.privateKey;
  process.env.SEED_ISSUER_PRIVATE_KEY = funder.privateKey;
  const client = createSeedClient(provider, sbtAddress);
  const events: SeedEvent[] = [];
  const options = { apply: true, expectedCodeHash: keccak256(await provider.getCode(sbtAddress)), emit: (e: SeedEvent) => events.push(e) };
  await seedDemo(config, client, options);
  const nonce = await provider.getTransactionCount(funder.address);
  assert.equal(events.filter((e) => e.event === "submitted").length, 3);
  const read = new Contract(sbtAddress, SBT_ABI, provider);
  const token = (await read.credentials(student))[0];
  assert.equal(await read.tierOf(normal), 0n);
  assert.equal(await read.tierOf(student), 1n);
  assert.equal(await provider.getBalance(normal), config.normal.targetBalanceWei);
  assert.equal(await provider.getBalance(student), config.student.targetBalanceWei);
  await seedDemo(config, client, options);
  assert.equal(await provider.getTransactionCount(funder.address), nonce);
  assert.equal((await read.credentials(student))[0], token);
  assert.equal(events.filter((e) => e.event === "submitted").length, 3);
  assert.equal(JSON.stringify(events).includes(funder.privateKey), false);
});
