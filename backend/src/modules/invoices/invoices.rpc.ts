export class InvoiceRpcError extends Error {
  readonly code: "RPC_UNAVAILABLE" | "WRONG_CHAIN";
  constructor(code: "RPC_UNAVAILABLE" | "WRONG_CHAIN" = "RPC_UNAVAILABLE") {
    super(code);
    this.code = code;
  }
}
export interface InvoiceRpc { call(method: string, params: unknown[]): Promise<unknown> }

export class HttpInvoiceRpc implements InvoiceRpc {
  private nextId = 0;
  private active = 0;
  private url?: URL;
  constructor(url?: string) {
    if (url?.trim()) {
      this.url = new URL(url);
      if (!["https:", "http:"].includes(this.url.protocol)) throw new Error("Invalid RPC URL");
    }
  }
  async call(method: string, params: unknown[]): Promise<unknown> {
    if (!this.url || this.active >= 4) throw new InvoiceRpcError();
    this.active++;
    try {
      const id = ++this.nextId;
      const response = await fetch(this.url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(5000), redirect: "error",
      });
      if (!response.ok || !response.body) throw new Error("RPC HTTP error");
      // Bound even a chunked response before JSON parsing.
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 2 * 1024 * 1024) throw new Error("RPC response too large");
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body?.jsonrpc !== "2.0" || body.id !== id || body.error || !Object.hasOwn(body, "result")) throw new Error("RPC protocol error");
      return body.result;
    } catch { throw new InvoiceRpcError(); }
    finally { this.active--; }
  }
}
