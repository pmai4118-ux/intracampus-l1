import { campusNetwork, getDeployment, requireDeployment } from "@intracampus/network";
export { campusNetwork };
export type WalletConfig = { rpcUrl?: string; sbtAddress?: string; paymentRegistryAddress?: string; posSignerAddress?: string };
export const campusChainHex = `0x${campusNetwork.chainId.toString(16)}`;
export function isWalletAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
}
export function validateWalletConfig(config: WalletConfig): WalletConfig {
  const rpcUrl = config.rpcUrl?.trim() || undefined;
  const sbtAddress = config.sbtAddress?.trim() || undefined;
  const paymentRegistryAddress = config.paymentRegistryAddress?.trim() || undefined;
  const posSignerAddress = config.posSignerAddress?.trim() || undefined;
  if (rpcUrl) {
    const url = new URL(rpcUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash
      || (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("INVALID_WALLET_CONFIG");
  }
  if (sbtAddress && !isWalletAddress(sbtAddress)) throw new Error("INVALID_WALLET_CONFIG");
  if (paymentRegistryAddress && !isWalletAddress(paymentRegistryAddress)) throw new Error("INVALID_WALLET_CONFIG");
  if (posSignerAddress && !isWalletAddress(posSignerAddress)) throw new Error("INVALID_WALLET_CONFIG");
  return { rpcUrl, sbtAddress, paymentRegistryAddress, posSignerAddress };
}
// Only public, build-time configuration. Never expose a key or RPC secret here.
export function walletConfigFromDeployment(config: WalletConfig, manifest: unknown = getDeployment(), allowLocal = false): WalletConfig {
  const data = getDeployment(manifest);
  if (data.status !== "deployed") return validateWalletConfig(config);
  if (allowLocal) {
    const url = new URL(config.rpcUrl ?? '');
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('INVALID_WALLET_CONFIG');
  }
  const shared = requireDeployment(data, { allowLocal });
  const addresses = { sbtAddress: shared.contracts.StudentSBTIdentity.address,
    paymentRegistryAddress: shared.contracts.CampusPaymentRegistry.address, posSignerAddress: shared.roles.posSigner };
  for (const key of Object.keys(addresses) as Array<keyof typeof addresses>) {
    if (config[key]?.trim() && config[key]!.trim().toLowerCase() !== addresses[key].toLowerCase()) {
      throw new Error("Wallet environment must match the canonical L06 deployment manifest");
    }
  }
  return validateWalletConfig({ ...config, ...addresses });
}
export function browserWalletConfig(): WalletConfig {
  return walletConfigFromDeployment({ rpcUrl: process.env.NEXT_PUBLIC_INTRACAMPUS_RPC_URL,
    sbtAddress: process.env.NEXT_PUBLIC_STUDENT_SBT_ADDRESS,
    paymentRegistryAddress: process.env.NEXT_PUBLIC_CAMPUS_PAYMENT_REGISTRY_ADDRESS,
    posSignerAddress: process.env.NEXT_PUBLIC_CAMPUS_POS_SIGNER_ADDRESS }, getDeployment(), process.env.NEXT_PUBLIC_ALLOW_LOCAL_ANVIL === 'true');
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
export function formatWalletBalanceCompact(wei: bigint, maxDecimals = 2): { display: string; exact: string; rounded: boolean } {
  const exact = formatWalletBalance(wei);
  const decimals = campusNetwork.nativeCurrency.decimals;
  const unit = BigInt(10) ** BigInt(decimals);
  if (wei % unit === BigInt(0) || maxDecimals >= decimals) {
    return { display: exact, exact, rounded: false };
  }
  const scale = BigInt(10) ** BigInt(decimals - maxDecimals);
  const truncatedUnits = wei / scale;
  const factor = BigInt(10) ** BigInt(maxDecimals);
  const whole = (truncatedUnits / factor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fraction = (truncatedUnits % factor).toString().padStart(maxDecimals, "0");
  return {
    display: `${whole},${fraction} ${campusNetwork.nativeCurrency.symbol}`,
    exact,
    rounded: wei % scale !== BigInt(0),
  };
}
