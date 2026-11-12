// Manual browser fixture on loopback; not part of production routes or L1 evidence.
import { createInterface } from "node:readline";
import { createB04Fixture } from "./b04-fixture.ts";
const fixture = await createB04Fixture(4104);
console.log("B04 SYNTHETIC RPC fixture: backend http://127.0.0.1:4104. Commands: paid, reverted, mismatch, offline, online, restart, quit");
const input = createInterface({ input: process.stdin });
for await (const command of input) {
  if (command === "quit") break;
  if (command === "offline") fixture.rpc.available = false;
  if (command === "online") { fixture.rpc.available = true; fixture.advance(); }
  if (command === "restart") await fixture.restart();
  if (["paid", "reverted", "mismatch"].includes(command) && fixture.latest) console.log("Synthetic tx hash:", fixture.settle(fixture.latest, command as "paid" | "reverted" | "mismatch"));
  console.log("Fixture command completed:", command);
}
await fixture.close(); input.close();
