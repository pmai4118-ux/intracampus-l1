import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import test from "node:test";
import { keccak256, toUtf8Bytes } from "ethers";
import { loadVerifiedArtifact } from "../script/load-verified-artifact.mjs";

async function project(t) {
  const dir = await mkdtemp(join(tmpdir(), "l04-artifact-test-"));
  t.after(async () => {
    const target = resolve(dir);
    assert(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith("l04-artifact-test-"));
    await rm(target, { recursive: true, force: true });
  });
  const sources = { "src/Payment.sol": "contract Payment {}\n", "lib/Signature.sol": "library Signature {}\n" };
  const artifact = { abi: [], bytecode: { object: "0x00" }, metadata: { sources: {} } };
  for (const [source, content] of Object.entries(sources)) {
    await mkdir(join(dir, source, ".."), { recursive: true });
    await writeFile(join(dir, source), content);
    artifact.metadata.sources[source] = { keccak256: keccak256(toUtf8Bytes(content)) };
  }
  const output = join(dir, "out/Payment.sol/Payment.json");
  await mkdir(join(output, ".."), { recursive: true });
  const save = () => writeFile(output, JSON.stringify(artifact));
  await save();
  return { dir, artifact, save };
}

test("accepts artifacts whose contract and imported sources match compiler metadata", async (t) => {
  const p = await project(t);
  assert.deepEqual(await loadVerifiedArtifact(p.dir, "Payment"), p.artifact);
});

test("rejects an edited contract before a stale artifact can be deployed as evidence", async (t) => {
  const p = await project(t);
  await writeFile(join(p.dir, "src/Payment.sol"), "contract Payment { uint256 changed; }\n");
  await assert.rejects(loadVerifiedArtifact(p.dir, "Payment"), /stale artifact for src\/Payment.sol; run forge build/);
});

test("rejects a changed transitive dependency", async (t) => {
  const p = await project(t);
  await writeFile(join(p.dir, "lib/Signature.sol"), "library Signature { uint256 constant CHANGED = 1; }\n");
  await assert.rejects(loadVerifiedArtifact(p.dir, "Payment"), /stale artifact for lib\/Signature.sol; run forge build/);
});

test("rejects missing metadata rather than skipping provenance verification", async (t) => {
  const p = await project(t);
  delete p.artifact.metadata;
  await p.save();
  await assert.rejects(loadVerifiedArtifact(p.dir, "Payment"), /missing compiler source metadata/);
});

test("rejects empty source metadata rather than skipping provenance verification", async (t) => {
  const p = await project(t);
  p.artifact.metadata.sources = {};
  await p.save();
  await assert.rejects(loadVerifiedArtifact(p.dir, "Payment"), /missing compiler source metadata/);
});
