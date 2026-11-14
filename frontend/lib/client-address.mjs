import { isIP } from "node:net";

function normalizeIp(value) {
  if (typeof value !== "string") return null;
  const address = value.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (!isIP(address)) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  return mapped ? mapped[1] : address;
}

export function parseTrustedProxyAddresses(value = "") {
  if (typeof value !== "string" || !value.trim()) return [];
  const addresses = value.split(",").map((item) => normalizeIp(item));
  if (addresses.some((address) => !address)) throw new Error("FRONTEND_TRUSTED_PROXY_ADDRESSES must contain IP addresses");
  return [...new Set(addresses)];
}

/** Resolve the client address using only a configured proxy chain. */
export function resolveClientAddress(remoteAddress, forwardedFor, trustedProxyAddresses = []) {
  const peer = normalizeIp(remoteAddress);
  if (!peer) return "";
  const trusted = new Set(trustedProxyAddresses.map(normalizeIp).filter(Boolean));
  if (!trusted.has(peer)) return peer;

  if (typeof forwardedFor !== "string" || !forwardedFor.trim()) return peer;
  const chain = forwardedFor.split(",").map(normalizeIp);
  if (chain.some((address) => !address)) return peer;

  let address = peer;
  for (let index = chain.length - 1; index >= 0 && trusted.has(address); index--) {
    address = chain[index];
  }
  return address;
}
