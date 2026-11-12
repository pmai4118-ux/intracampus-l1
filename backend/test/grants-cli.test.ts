import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const backend = fileURLToPath(new URL("../", import.meta.url));
async function cli(args: string[]) {
  try {
    const result = await exec(process.execPath, ["scripts/seed-grants.ts", ...args], { cwd: backend,
      env: { ...process.env, INTRACAMPUS_RPC_URL: "https://SECRET_RPC_TOKEN.invalid", SEED_GRANT_ISSUER_PRIVATE_KEY: "SECRET_KEY" },
      windowsHide: true, timeout: 10000 });
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as { stdout: string; stderr: string; code: number };
    return result;
  }
}
test("CLI help describes read-only default and explicit apply without requiring credentials", async () => {
  const result = await cli(["--help"]);
  assert.equal(result.code, 0); assert.match(result.stdout, /dry-run/); assert.match(result.stdout, /--apply/);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET/);
});
test("CLI refuses unconfigured L06 manifest and never logs supplied secrets", async () => {
  const result = await cli(["--accounts", "scripts/demo-accounts.example.json"]);
  assert.equal(result.code, 1); assert.match(result.stderr, /DEPLOYMENT_NOT_CONFIGURED/);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET/);
});
test("CLI unknown options fail closed without echoing arbitrary input", async () => {
  const result = await cli(["--SECRET_OPTION"]);
  assert.equal(result.code, 1); assert.match(result.stderr, /SEED_FAILED/);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET/);
});
