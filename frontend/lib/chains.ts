import { campusNetwork } from "@intracampus/network";
export { campusNetwork };
export type WalletConfig = { rpcUrl?: string; sbtAddress?: string };
export const campusChainHex = `0x${campusNetwork.chainId.toString(16)}`;
export function isWalletAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
}
export function validateWalletConfig(config: WalletConfig): WalletConfig {
  const rpcUrl = config.rpcUrl?.trim() || undefined;
  const sbtAddress = config.sbtAddress?.trim() || undefined;
  if (rpcUrl) {
    const url = new URL(rpcUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash
      || (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("INVALID_WALLET_CONFIG");
  }
  if (sbtAddress && !isWalletAddress(sbtAddress)) throw new Error("INVALID_WALLET_CONFIG");
  return { rpcUrl, sbtAddress };
}
// Only public, build-time configuration. Never expose a key or RPC secret here.
export function browserWalletConfig(): WalletConfig {
  return validateWalletConfig({ rpcUrl: process.env.NEXT_PUBLIC_INTRACAMPUS_RPC_URL,
    sbtAddress: process.env.NEXT_PUBLIC_STUDENT_SBT_ADDRESS });
}
export function walletChainParameters(config: WalletConfig) {
  const { rpcUrl } = validateWalletConfig(config);
  if (!rpcUrl) throw new Error("RPC_NOT_CONFIGURED");
  return { chainId: campusChainHex, chainName: campusNetwork.name,
    nativeCurrency: { ...campusNetwork.nativeCurrency }, rpcUrls: [rpcUrl] };
}
export function formatWalletBalance(wei: bigint): string {
  const unit = BigInt(10) ** BigInt(campusNetwork.nativeCurrency.decimals);
  const whole = (wei / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fraction = (wei % unit).toString().padStart(campusNetwork.nativeCurrency.decimals, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `,${fraction}` : ""} ${campusNetwork.nativeCurrency.symbol}`;
}
