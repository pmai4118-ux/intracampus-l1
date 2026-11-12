import { getDeployment, requireDeployment } from "@intracampus/network";
export type InvoiceCreationConfig = { merchant?: string; privateKey?: string; expectedSigner?: string; studentSbt?: string };

// Only public merchant metadata reaches the envelope; never serialize this config.
export function readInvoiceCreationConfig(env: NodeJS.ProcessEnv, manifest: unknown = getDeployment()): InvoiceCreationConfig {
  const data = getDeployment(manifest);
  const merchant = env.PARKING_MERCHANT_ADDRESS?.trim();
  const privateKey = env.POS_SIGNER_PRIVATE_KEY?.trim();
  if (data.status !== "deployed") return { merchant, privateKey };
  const shared = requireDeployment(data);
  if (merchant && merchant.toLowerCase() !== shared.merchants.parking.address.toLowerCase()) {
    throw new Error("Invoice merchant must match the canonical L06 deployment manifest");
  }
  return { merchant: shared.merchants.parking.address, privateKey, expectedSigner: shared.roles.posSigner,
    studentSbt: shared.contracts.StudentSBTIdentity.address };
}

export const parkingService = {
  merchantId: "parking-demo", merchantName: "Bãi xe demo",
  serviceId: "parking-single", serviceName: "Một lượt gửi xe demo",
  categoryCode: "PARKING", amount: 3000000000000000000000n, ttlSeconds: 300,
} as const;
