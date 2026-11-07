import { createApp } from "./app.ts";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");

createApp(process.env.INTRACAMPUS_RPC_URL).listen(port, host, () => {
  console.log(`IntraCampus API listening at http://${host}:${port}`);
});
