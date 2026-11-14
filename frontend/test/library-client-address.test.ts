import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const resolveClientAddressModule = pathToFileURL(join(fileURLToPath(new URL("../", import.meta.url)), "lib", "client-address.mjs")).href;
const { parseTrustedProxyAddresses, resolveClientAddress } = await import(resolveClientAddressModule);

test("frontend ingress ignores forged forwarding headers from direct clients", () => {
  assert.equal(resolveClientAddress("198.51.100.4", "203.0.113.9", []), "198.51.100.4");
});

test("frontend ingress resolves the first untrusted address in an explicitly trusted proxy chain", () => {
  const trusted = parseTrustedProxyAddresses("10.0.0.3,10.0.0.2,::ffff:10.0.0.1");
  assert.equal(resolveClientAddress("10.0.0.3", "203.0.113.9, 198.51.100.7, 10.0.0.2", trusted), "198.51.100.7",
    "the actual client address appended by the trusted ingress wins over a forged leftmost value");
  assert.equal(resolveClientAddress("10.0.0.3", "not-an-ip", trusted), "10.0.0.3",
    "a malformed forwarded chain fails closed to the trusted peer address");
});
