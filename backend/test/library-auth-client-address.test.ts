import assert from "node:assert/strict";
import test from "node:test";
import { authClientAddress, parseIpAddressList } from "../src/modules/auth/client-address.ts";

test("auth rate limit uses a forwarded client only from an exact trusted proxy and only as one sanitized IP", () => {
  const trusted = parseIpAddressList("127.0.0.1,::1");
  assert.equal(authClientAddress("198.51.100.4", "203.0.113.9", trusted), "198.51.100.4",
    "a direct untrusted caller cannot choose a limiter identity with X-Forwarded-For");
  assert.equal(authClientAddress("::ffff:127.0.0.1", "198.51.100.7", trusted), "198.51.100.7",
    "a trusted Next proxy can forward the ingress-sanitized client address");
  assert.equal(authClientAddress("127.0.0.1", "198.51.100.7, 203.0.113.3", trusted), "127.0.0.1",
    "the backend accepts exactly one sanitized hop from Next");
  assert.throws(() => parseIpAddressList("localhost,127.0.0.1"), { message: "INVALID_IP_ADDRESS_LIST" });
});
