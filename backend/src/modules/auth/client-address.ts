import { isIP } from "node:net";

function normalizedIp(value: string): string | null {
  const address = value.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (!isIP(address)) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  return mapped ? mapped[1] : address;
}

export function parseIpAddressList(value: string): string[] {
  if (!value.trim()) return [];
  const addresses = value.split(",").map(normalizedIp);
  if (addresses.some((address) => !address)) throw new Error("INVALID_IP_ADDRESS_LIST");
  return [...new Set(addresses.filter((address): address is string => address !== null))];
}

export function authClientAddress(
  peerAddress: string,
  forwardedFor: string | undefined,
  trustedProxyAddresses: readonly string[],
): string {
  const peer = normalizedIp(peerAddress);
  if (!peer) return "";
  const trusted = new Set(trustedProxyAddresses.map(normalizedIp).filter((address): address is string => address !== null));
  if (!trusted.has(peer) || !forwardedFor || forwardedFor.includes(",")) return peer;
  return normalizedIp(forwardedFor) ?? peer;
}
