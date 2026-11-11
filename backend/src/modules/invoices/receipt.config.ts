import { isAddress, safeInteger } from "./invoices.schema.ts";
import type { InvoiceDeployment } from "./receipt.service.ts";

export function readInvoiceDeployment(env: NodeJS.ProcessEnv): InvoiceDeployment | undefined {
  const address = env.CAMPUS_PAYMENT_REGISTRY_ADDRESS?.trim();
  const block = env.CAMPUS_PAYMENT_DEPLOYMENT_BLOCK?.trim();
  if (!address && !block) return undefined;
  if (!isAddress(address) || !block || !/^(0|[1-9][0-9]*)$/.test(block) || !safeInteger(Number(block))) {
    throw new Error("Set CAMPUS_PAYMENT_REGISTRY_ADDRESS and CAMPUS_PAYMENT_DEPLOYMENT_BLOCK from the same L06 deployment");
  }
  return { contractAddress: address, deploymentBlock: Number(block) };
}
