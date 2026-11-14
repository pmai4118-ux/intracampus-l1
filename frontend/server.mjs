import { createServer } from "node:http";
import next from "next";
import { parseTrustedProxyAddresses, resolveClientAddress } from "./lib/client-address.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dev = process.argv.includes("--dev");
const hostname = option("--hostname") ?? "127.0.0.1";
const port = Number(option("--port") ?? process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");

const trustedProxyAddresses = parseTrustedProxyAddresses(process.env.FRONTEND_TRUSTED_PROXY_ADDRESSES);
const app = next({ dev, hostname, port });
await app.prepare();
const handle = app.getRequestHandler();
const handleUpgrade = app.getUpgradeHandler?.();

function sanitizeClientAddress(req) {
  const address = resolveClientAddress(
    req.socket.remoteAddress ?? "",
    typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"] : undefined,
    trustedProxyAddresses,
  );
  if (address) req.headers["x-forwarded-for"] = address;
  else delete req.headers["x-forwarded-for"];
}

const server = createServer((req, res) => {
  sanitizeClientAddress(req);
  Promise.resolve(handle(req, res)).catch((error) => {
    if (!res.headersSent) res.writeHead(500);
    res.destroy(error instanceof Error ? error : undefined);
  });
});

if (handleUpgrade) {
  server.on("upgrade", (req, socket, head) => {
    sanitizeClientAddress(req);
    Promise.resolve(handleUpgrade(req, socket, head)).catch(() => socket.destroy());
  });
}

server.listen(port, hostname, () => {
  process.stdout.write(`IntraCampus frontend listening on http://${hostname}:${port}\n`);
});
