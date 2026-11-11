import { isAddress, safeInteger } from "./invoices.schema.ts";
import type { InvoiceDeployment } from "./receipt.service.ts";
import { getDeployment, requireDeployment } from "@intracampus/network";

export function readInvoiceDeployment(env: NodeJS.ProcessEnv, manifest: unknown = getDeployment()): InvoiceDeployment | undefined {
  const data = getDeployment(manifest);
  const configured = data.status === "deployed" ? requireDeployment(data) : undefined;
  const shared = configured?.contracts.CampusPaymentRegistry;
  const address = env.CAMPUS_PAYMENT_REGISTRY_ADDRESS?.trim();
  const block = env.CAMPUS_PAYMENT_DEPLOYMENT_BLOCK?.trim();
  if (!address && !block) return shared ? { contractAddress: shared.address, deploymentBlock: shared.blockNumber } : undefined;
  if (!isAddress(address) || !block || !/^(0|[1-9][0-9]*)$/.test(block) || !safeInteger(Number(block))) {
    throw new Error("Set CAMPUS_PAYMENT_REGISTRY_ADDRESS and CAMPUS_PAYMENT_DEPLOYMENT_BLOCK from the same L06 deployment");
  }
  if (shared && (address.toLowerCase() !== shared.address.toLowerCase() || Number(block) !== shared.blockNumber)) {
    throw new Error("Receipt environment must match the canonical L06 deployment manifest");
  }
  return { contractAddress: address, deploymentBlock: Number(block) };
}
