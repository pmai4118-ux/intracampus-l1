import { campusNetwork, type NetworkProbe } from "@intracampus/network";

export async function probeNetwork(rpcUrl?: string, now: () => number = Date.now): Promise<NetworkProbe> {
  const expectedChainId = campusNetwork.chainId;
  if (!rpcUrl?.trim()) return { status: "not-configured", expectedChainId };

  try {
    const url = new URL(rpcUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid RPC URL");

    const signal = AbortSignal.timeout(2500);
    const read = async (method: string, params: unknown[]) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal,
        redirect: "error",
      });
      if (!res.ok) throw new Error("RPC request failed");
      const body = await res.json();
      if (body?.id !== 1 || body.jsonrpc !== "2.0" || body.error) throw new Error("Invalid RPC response");
      return body.result;
    };
    const quantity = (value: unknown) => {
      if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error("Invalid quantity");
      const parsed = Number(BigInt(value));
      if (!Number.isSafeInteger(parsed)) throw new Error("Unsupported quantity");
      return parsed;
    };
    const [chain, block] = await Promise.all([read("eth_chainId", []), read("eth_getBlockByNumber", ["latest", false])]);
    const chainId = quantity(chain);
    if (!block || typeof block !== "object") {
      throw new Error("Invalid latest block");
    }
    const latestBlock = { number: quantity(block.number), timestamp: quantity(block.timestamp) };
    return { status: chainId === expectedChainId ? "ready" : "wrong-chain", expectedChainId, chainId,
      latestBlock, headAgeSeconds: Math.floor(now() / 1000) - latestBlock.timestamp };
  } catch {
    return { status: "unreachable", expectedChainId };
  }
}
