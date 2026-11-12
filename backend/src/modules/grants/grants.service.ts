import { FetchRequest, JsonRpcProvider } from "ethers";
import { requireDeployment } from "@intracampus/network";
import { grantAddress, grantHash, GrantsReader } from "./grants.rpc.ts";
import { GrantError } from "./grants.types.ts";
import type { GrantLookup } from "./grants.types.ts";
export type GrantsConfig = { rpcUrl?: string; deployment?: unknown; allowLocal?: boolean; provider?: JsonRpcProvider };
export class GrantsService {
  private readonly config: GrantsConfig;
  private provider?: JsonRpcProvider;
  private closed = false;
  constructor(config: GrantsConfig = {}) { this.config = config; this.provider = config.provider; }
  close(): void {
    this.closed = true;
    if (!this.config.provider) this.provider?.destroy();
  }
  async lookup(beneficiary: string, txHash?: string): Promise<GrantLookup> {
    if (this.closed) throw new GrantError("RPC_UNAVAILABLE");
    beneficiary = grantAddress(beneficiary);
    if (txHash !== undefined && !grantHash(txHash)) throw new GrantError("INVALID_REQUEST");
    let deployment;
    try { deployment = requireDeployment(this.config.deployment, { allowLocal: this.config.allowLocal }); }
    catch (error) { throw new GrantError(error instanceof Error && error.message === "DEPLOYMENT_NOT_CONFIGURED" ? error.message : "INVALID_DEPLOYMENT"); }
    if (!this.provider) {
      try {
        if (!this.config.rpcUrl?.trim()) throw new Error();
        const url = new URL(this.config.rpcUrl);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
        const request = new FetchRequest(url.href); request.timeout = 5000;
        this.provider = new JsonRpcProvider(request, 20261, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
      } catch { throw new GrantError("RPC_UNAVAILABLE"); }
    }
    const reader = new GrantsReader(this.provider, deployment);
    // Verify the transaction first so the balance snapshot is at least as recent as its receipt.
    const events = txHash ? await reader.verifyReceipt(txHash, beneficiary) : null;
    const snapshot = await reader.snapshot(beneficiary, events ?? []);
    return { schemaVersion: 1, status: "verified", chainId: 20261, beneficiary,
      vaultAddress: deployment.contracts.PurposeBoundGrantVault.address,
      category: { id: deployment.merchants.canteen.category, label: "FOOD" }, balanceWei: snapshot.balanceWei.toString(),
      block: { number: snapshot.blockNumber, hash: snapshot.blockHash },
      allowedMerchants: [{ id: "canteen", address: deployment.merchants.canteen.address, allowed: snapshot.merchantAllowed }],
      transaction: txHash ? { hash: txHash, status: events ? "verified" : "pending", events: events ?? [] } : null };
  }
}
