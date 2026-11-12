import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { deploymentResponse, getDeployment, requireDeployment } from "@intracampus/network";
import { createApp } from "../src/app.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const FOOD = "0x2f6f5a261d6f4514c3f09a834720fe583c82f2ee4758ce9a45fbd67428e9f93d";
const PARKING = "0xe3415db38bf7529604e320f58333c9ff6b278ff38b3391db9da4273c7be086eb";
const parameter = (type: string, name = "") => ({ type, name });
const invoice = () => ({ type: "tuple", name: "invoice", components: [
  parameter("bytes32", "invoiceId"), parameter("address", "merchant"), parameter("bytes32", "category"),
  parameter("uint256", "amount"), parameter("uint64", "expiresAt"),
] });
const fn = (name: string, inputs: Record<string, unknown>[], outputs: string[], stateMutability = "view") =>
  ({ type: "function", name, inputs, outputs: outputs.map((type) => parameter(type)), stateMutability });
const event = (name: string, fields: [string, string, boolean][]) => ({
  type: "event", name, anonymous: false, inputs: fields.map(([type, name, indexed]) => ({ type, name, indexed })),
});
function abis(): Record<string, Record<string, unknown>[]> {
  return {
    StudentSBTIdentity: [
      fn("issuer", [], ["address"]), fn("credentials", [parameter("address")], ["uint256", "uint64"]),
      fn("tierOf", [parameter("address")], ["uint8"]),
      fn("mint", [parameter("address"), parameter("uint64")], ["uint256"], "nonpayable"),
      fn("revoke", [parameter("uint256")], [], "nonpayable"),
      event("Transfer", [["address", "from", true], ["address", "to", true], ["uint256", "tokenId", true]]),
      event("Locked", [["uint256", "tokenId", false]]),
    ],
    CampusPaymentRegistry: [
      fn("admin", [], ["address"]), fn("posSigner", [], ["address"]), fn("studentSbt", [], ["address"]),
      fn("allowedMerchantCategories", [parameter("address"), parameter("bytes32")], ["bool"]),
      fn("setMerchantCategory", [parameter("address"), parameter("bytes32"), parameter("bool")], [], "nonpayable"),
      fn("quoteInvoice", [invoice(), parameter("address")], ["uint8", "uint256", "uint256"]),
      fn("isInvoicePaid", [parameter("bytes32")], ["bool"]),
      fn("payInvoice", [invoice(), parameter("bytes")], [], "payable"),
      event("InvoicePaid", [["bytes32", "invoiceId", true], ["address", "payer", true], ["address", "merchant", true],
        ["bytes32", "category", false], ["uint256", "originalAmount", false], ["uint256", "discountAmount", false],
        ["uint256", "paidAmount", false], ["uint8", "tier", false]]),
      event("MerchantCategoryUpdated", [["address", "merchant", true], ["bytes32", "category", true], ["bool", "allowed", false]]),
    ],
    PurposeBoundGrantVault: [
      fn("issuer", [], ["address"]), fn("merchantRegistry", [], ["address"]),
      fn("balances", [parameter("address"), parameter("bytes32")], ["uint256"]), fn("totalAllocated", [], ["uint256"]),
      fn("grant", [parameter("address"), parameter("bytes32")], [], "payable"),
      fn("spend", [parameter("address"), parameter("bytes32"), parameter("uint256")], [], "nonpayable"),
      event("GrantIssued", [["address", "beneficiary", true], ["bytes32", "category", true], ["address", "issuer", true],
        ["uint256", "amount", false], ["uint256", "balance", false]]),
      event("GrantSpent", [["address", "beneficiary", true], ["address", "merchant", true], ["bytes32", "category", true],
        ["uint256", "amount", false], ["uint256", "balance", false]]),
    ],
  };
}
function fixture(): Record<string, any> {
  const abi = abis();
  return { schemaVersion: 1, status: "deployed", chainId: 20261, abiVersion: 1, environment: "avalanche-l1",
    contracts: Object.fromEntries(["StudentSBTIdentity", "CampusPaymentRegistry", "PurposeBoundGrantVault"].map((name, i) =>
      [name, { address: addr(i + 1), transactionHash: hash(i + 1), blockNumber: i + 1,
        blockHash: hash(i + 5), runtimeCodeHash: hash(i + 10), abiVersion: 1, abi: abi[name] }])),
    roles: { deployer: addr(10), sbtIssuer: addr(10), grantIssuer: addr(10), posSigner: addr(11) },
    merchants: { parking: { address: addr(20), category: PARKING }, canteen: { address: addr(21), category: FOOD } } };
}

test("an unconfigured manifest cannot activate client transactions", () => {
  const value = { schemaVersion: 1, abiVersion: 1, chainId: 20261, status: "unconfigured" };
  assert.equal(getDeployment(value).status, "unconfigured");
  assert.throws(() => requireDeployment(value), /DEPLOYMENT_NOT_CONFIGURED/);
});
test("confirmed production manifest is consumed without altering ABI or addresses", () => {
  const value = fixture();
  assert.equal(requireDeployment(value), value);
  assert.equal(deploymentResponse(value).body, value);
});
test("local evidence is opt-in and cannot activate the production endpoint", () => {
  const value = { ...fixture(), environment: "local-anvil" };
  assert.equal(requireDeployment(value, { allowLocal: true }), value);
  assert.throws(() => requireDeployment(value), /INVALID_DEPLOYMENT/);
  assert.equal(deploymentResponse(value).status, 503);
});
for (const [label, change] of [
  ["wrong chain", (x: any) => { x.chainId = 43113; }],
  ["wrong ABI version", (x: any) => { x.abiVersion = 2; }],
  ["null address", (x: any) => { x.contracts.StudentSBTIdentity.address = null; }],
  ["missing receipt", (x: any) => { x.contracts.CampusPaymentRegistry.transactionHash = null; }],
  ["duplicate contract", (x: any) => { x.contracts.PurposeBoundGrantVault.address = addr(1); }],
  ["missing ABI", (x: any) => { x.contracts.StudentSBTIdentity.abi = []; }],
  ["zero role", (x: any) => { x.roles.posSigner = addr(0); }],
  ["invalid merchant", (x: any) => { x.merchants.canteen.category = hash(0); }],
  ["wrong nonzero category", (x: any) => { x.merchants.canteen.category = PARKING; }],
  ["duplicate merchants", (x: any) => { x.merchants.canteen.address = x.merchants.parking.address; }],
  ["merchant is signing role", (x: any) => { x.merchants.canteen.address = x.roles.posSigner; }],
  ["merchant is contract", (x: any) => { x.merchants.canteen.address = x.contracts.PurposeBoundGrantVault.address; }],
  ["issuer is deployed contract", (x: any) => { x.roles.grantIssuer = x.contracts.StudentSBTIdentity.address; }],
  ["fake ABI", (x: any) => { x.contracts.StudentSBTIdentity.abi = [{ type: "anything" }]; }],
  ["missing payment function", (x: any) => { x.contracts.CampusPaymentRegistry.abi = x.contracts.CampusPaymentRegistry.abi.filter((entry: any) => entry.name !== "payInvoice"); }],
  ["payment cannot receive CAMPUS", (x: any) => { x.contracts.CampusPaymentRegistry.abi.find((entry: any) => entry.name === "payInvoice").stateMutability = "nonpayable"; }],
  ["wrong tier output", (x: any) => { x.contracts.StudentSBTIdentity.abi.find((entry: any) => entry.name === "tierOf").outputs[0].type = "uint256"; }],
  ["wrong invoice expiry type", (x: any) => { x.contracts.CampusPaymentRegistry.abi.find((entry: any) => entry.name === "payInvoice").inputs[0].components[4].type = "uint256"; }],
  ["wrong invoice field name", (x: any) => { x.contracts.CampusPaymentRegistry.abi.find((entry: any) => entry.name === "payInvoice").inputs[0].components[0].name = "untrustedInvoiceId"; }],
  ["missing grant event", (x: any) => { x.contracts.PurposeBoundGrantVault.abi = x.contracts.PurposeBoundGrantVault.abi.filter((entry: any) => entry.name !== "GrantSpent"); }],
  ["wrong grant event index", (x: any) => { x.contracts.PurposeBoundGrantVault.abi.find((entry: any) => entry.name === "GrantSpent").inputs[0].indexed = false; }],
  ["wrong grant event field name", (x: any) => { x.contracts.PurposeBoundGrantVault.abi.find((entry: any) => entry.name === "GrantSpent").inputs[0].name = "recipient"; }],
  ["anonymous payment event", (x: any) => { x.contracts.CampusPaymentRegistry.abi.find((entry: any) => entry.name === "InvoicePaid").anonymous = true; }],
  ["duplicate function with changed output", (x: any) => { const entry = structuredClone(x.contracts.StudentSBTIdentity.abi[0]); entry.outputs[0].type = "uint256"; x.contracts.StudentSBTIdentity.abi.push(entry); }],
  ["noncanonical extra ABI type", (x: any) => { x.contracts.StudentSBTIdentity.abi.push(fn("extra", [parameter("uint008")], [])); }],
] as const) {
  test(`client refuses ${label}`, () => {
    const value = fixture(); change(value);
    assert.throws(() => requireDeployment(value));
    assert.equal(deploymentResponse(value).status, 503);
  });
}
test("administrative roles may share a demo operator, but not merchant or contract addresses", () => {
  const value = fixture();
  value.roles.posSigner = value.roles.deployer;
  assert.equal(requireDeployment(value), value);
});
test("backend uses the shared client deployment response and fails closed", async (t) => {
  const server = createServer(createApp()).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const backend = await fetch(`http://127.0.0.1:${address.port}/api/deployment`);
  const shared = deploymentResponse();
  assert.equal(shared.status, backend.status);
  assert.equal(backend.headers.get("cache-control"), "no-store");
  assert.deepEqual(shared.body, await backend.json());
});
