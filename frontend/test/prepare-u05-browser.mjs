// Test utility: build the actual Student UI in an ignored copy with a local-only fixture.
// Usage: node frontend/test/prepare-u05-browser.mjs backend/data/<run>/browser
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { requireDeployment } from "@intracampus/network";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = resolve(process.argv[2] ?? "");
assert.equal(process.argv.length, 3, "Pass the ignored browser fixture directory");
assert(directory.toLowerCase().startsWith((join(root, "backend", "data") + sep).toLowerCase()), "Fixture must remain in backend/data");
const config = JSON.parse(await readFile(join(directory, "public-config.json"), "utf8"));
assert.equal(config.environment, "local-anvil"); assert.equal(config.chainId, 20261);
for (const value of [config.rpcUrl, config.api]) {
  const url = new URL(value);
  assert.equal(url.protocol, "http:"); assert.equal(url.hostname, "127.0.0.1");
}
const local = requireDeployment(config.manifest, { allowLocal: true });
assert.equal(local.environment, "local-anvil");
const target = join(directory, "source");
await mkdir(target); // Refuse to overwrite a previous run.
const filter = (path) => !["node_modules", ".next", ".git", "dist"].includes(basename(path)) && !basename(path).startsWith(".env");
for (const name of ["frontend", "packages", "deployments"]) await cp(join(root, name), join(target, name), { recursive: true, filter });
for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "tsconfig.json"]) {
  try { await cp(join(root, name), join(target, name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
await mkdir(join(target, "backend")); await cp(join(root, "backend/package.json"), join(target, "backend/package.json"));
// Production deliberately rejects local manifests. Only this disposable test copy
// receives the deployed-shape fixture; the real API still verifies local-anvil data.
await writeFile(join(target, "deployments/intracampus.json"), JSON.stringify({ ...local, environment: "avalanche-l1" }, null, 2) + "\n");
await writeFile(join(target, "frontend/.env.local"), `NEXT_PUBLIC_INTRACAMPUS_RPC_URL=${config.rpcUrl}\nBACKEND_URL=${config.api}\n`);
const sha = (data) => createHash("sha256").update(data).digest("hex");
const files = ["frontend/app/student/GrantPanel.tsx", "frontend/lib/grants.ts", "frontend/lib/wallet.ts", "frontend/next.config.ts", "packages/network/src/deployment.ts"];
const sourceHashes = {};
for (const name of files) {
  sourceHashes[name] = sha(await readFile(join(root, name)));
  assert.equal(sha(await readFile(join(target, name))), sourceHashes[name]);
}
const provenance = { environment: "local-anvil", sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim(),
  sourceHashes, canonicalManifestSha256: sha(await readFile(join(root, "deployments/intracampus.json"))),
  overrides: ["Ignored source copy only: deployment manifest has local addresses with deployed environment shape for UI testing", "Public loopback RPC/BACKEND_URL in copied .env.local", "Injected EIP-1193 test wallet and visible local-test banner supplied by Python"],
  scope: "Actual current GrantPanel/controllers/proxy source. Not a production deployment or Core/physical-device/L1 acceptance." };
await writeFile(join(directory, "source-provenance.json"), JSON.stringify(provenance, null, 2) + "\n", { flag: "wx" });
process.stdout.write("Prepared ignored UI source copy; canonical manifest and operator .env were not modified.\n");
