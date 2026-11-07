import { probeNetwork } from "./network.ts";

const result = await probeNetwork(process.env.INTRACAMPUS_RPC_URL);
console.log(JSON.stringify(result, null, 2));
if (result.status !== "ready") process.exitCode = 1;
