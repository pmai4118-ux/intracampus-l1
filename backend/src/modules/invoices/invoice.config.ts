export type InvoiceCreationConfig = { merchant?: string; privateKey?: string };

// Only public merchant metadata reaches the envelope; never serialize this config.
export function readInvoiceCreationConfig(env: NodeJS.ProcessEnv): InvoiceCreationConfig {
  return { merchant: env.PARKING_MERCHANT_ADDRESS?.trim(), privateKey: env.POS_SIGNER_PRIVATE_KEY?.trim() };
}

export const parkingService = {
  merchantId: "parking-demo", merchantName: "Bãi xe demo",
  serviceId: "parking-single", serviceName: "Một lượt gửi xe demo",
  categoryCode: "PARKING", amount: 3000000000000000000000n, ttlSeconds: 300,
} as const;
