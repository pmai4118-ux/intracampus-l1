import { campusNetwork, type NetworkProbe } from "@intracampus/network";

export async function probeNetwork(rpcUrl?: string): Promise<NetworkProbe> {
  const expectedChainId = campusNetwork.chainId;
  if (!rpcUrl?.trim()) return { status: "not-configured", expectedChainId };

  try {
    const url = new URL(rpcUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid RPC URL");

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(2500),
      redirect: "error",
    });
    if (!res.ok) throw new Error("RPC request failed");
    const body = await res.json();
    if (body?.id !== 1 || body.jsonrpc !== "2.0" || body.error ||
      typeof body.result !== "string" || !/^0x[0-9a-f]+$/i.test(body.result)) {
      throw new Error("Invalid eth_chainId response");
    }
    const chainId = Number(BigInt(body.result));
    if (!Number.isSafeInteger(chainId)) throw new Error("Unsupported chain ID");
    return { status: chainId === expectedChainId ? "ready" : "wrong-chain", expectedChainId, chainId };
  } catch {
    return { status: "unreachable", expectedChainId };
  }
}
