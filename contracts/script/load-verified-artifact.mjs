import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { keccak256 } from "ethers";

// Refuse stale build output before using it as evidence for the current sources.
export async function loadVerifiedArtifact(contractsDir, name) {
  const artifact = JSON.parse(await readFile(join(contractsDir, "out", `${name}.sol`, `${name}.json`), "utf8"));
  const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
  assert(metadata?.sources && Object.keys(metadata.sources).length > 0,
    `${name}: missing compiler source metadata; run forge build`);
  for (const [source, expected] of Object.entries(metadata.sources)) {
    const actual = keccak256(await readFile(join(contractsDir, source)));
    assert.equal(actual, expected.keccak256, `${name}: stale artifact for ${source}; run forge build`);
  }
  return artifact;
}
