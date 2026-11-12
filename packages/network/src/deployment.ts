import manifest from "../../../deployments/intracampus.json" with { type: "json" };
import { campusNetwork } from "./chain.ts";

const names = ["StudentSBTIdentity", "CampusPaymentRegistry", "PurposeBoundGrantVault"] as const;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const categories = {
  parking: "0xe3415db38bf7529604e320f58333c9ff6b278ff38b3391db9da4273c7be086eb",
  canteen: "0x2f6f5a261d6f4514c3f09a834720fe583c82f2ee4758ce9a45fbd67428e9f93d",
} as const;
const invoice = "(bytes32,address,bytes32,uint256,uint64)";
const eventNames: Record<string, string[]> = {
  Transfer: ["from", "to", "tokenId"], Locked: ["tokenId"],
  InvoicePaid: ["invoiceId", "payer", "merchant", "category", "originalAmount", "discountAmount", "paidAmount", "tier"],
  MerchantCategoryUpdated: ["merchant", "category", "allowed"],
  GrantIssued: ["beneficiary", "category", "issuer", "amount", "balance"],
  GrantSpent: ["beneficiary", "merchant", "category", "amount", "balance"],
};
const requiredAbi = {
  StudentSBTIdentity: [
    "function:issuer()->address:view", "function:credentials(address)->uint256,uint64:view",
    "function:tierOf(address)->uint8:view", "function:mint(address,uint64)->uint256:nonpayable",
    "function:revoke(uint256)->:nonpayable",
    "event:Transfer(address,address,uint256):111", "event:Locked(uint256):0",
  ],
  CampusPaymentRegistry: [
    "function:admin()->address:view", "function:posSigner()->address:view",
    "function:studentSbt()->address:view", "function:allowedMerchantCategories(address,bytes32)->bool:view",
    "function:setMerchantCategory(address,bytes32,bool)->:nonpayable",
    `function:quoteInvoice(${invoice},address)->uint8,uint256,uint256:view`,
    "function:isInvoicePaid(bytes32)->bool:view", `function:payInvoice(${invoice},bytes)->:payable`,
    "event:InvoicePaid(bytes32,address,address,bytes32,uint256,uint256,uint256,uint8):11100000",
    "event:MerchantCategoryUpdated(address,bytes32,bool):110",
  ],
  PurposeBoundGrantVault: [
    "function:issuer()->address:view", "function:merchantRegistry()->address:view",
    "function:balances(address,bytes32)->uint256:view", "function:totalAllocated()->uint256:view",
    "function:grant(address,bytes32)->:payable", "function:spend(address,bytes32,uint256)->:nonpayable",
    "event:GrantIssued(address,bytes32,address,uint256,uint256):11100",
    "event:GrantSpent(address,address,bytes32,uint256,uint256):11100",
  ],
} as const;
export type PublicContract = {
  address: string; abiVersion: 1; abi: Record<string, unknown>[];
  transactionHash: string; blockNumber: number; blockHash: string; runtimeCodeHash: string;
};
export type DeployedManifest = {
  schemaVersion: 1; status: "deployed"; chainId: number; abiVersion: 1;
  environment: "avalanche-l1" | "local-anvil";
  contracts: Record<typeof names[number], PublicContract>;
  roles: { deployer: string; sbtIssuer: string; grantIssuer: string; posSigner: string };
  merchants: { parking: { address: string; category: string }; canteen: { address: string; category: string } };
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_DEPLOYMENT");
  return value as Record<string, unknown>;
}
function isAddress(value: unknown): value is string {
  return typeof value === "string" && addressPattern.test(value) && !/^0x0{40}$/i.test(value);
}
function isHash(value: unknown): value is string {
  return typeof value === "string" && hashPattern.test(value) && !/^0x0{64}$/i.test(value);
}

// Validate the JSON ABI without a browser crypto dependency. Tuple component types and event
// indexing matter for P02 encoding/log decoding; merely checking that ABI is a nonempty array
// would allow a manifest that looks ready but cannot construct or verify transactions.
function parameterType(value: unknown, depth = 0): string {
  const parameter = object(value);
  if (depth > 8 || typeof parameter.type !== "string") throw new Error("INVALID_DEPLOYMENT");
  const match = /^([a-zA-Z0-9]+)((?:\[(?:[1-9][0-9]*)?\])*)$/.exec(parameter.type);
  if (!match) throw new Error("INVALID_DEPLOYMENT");
  const [, base, suffix] = match;
  if (base === "tuple") {
    if (!Array.isArray(parameter.components) || parameter.components.length === 0) throw new Error("INVALID_DEPLOYMENT");
    return `(${parameter.components.map((entry) => parameterType(entry, depth + 1)).join(",")})${suffix}`;
  }
  const integer = /^(?:u?int)([0-9]+)$/.exec(base);
  const fixedBytes = /^bytes([0-9]+)$/.exec(base);
  if (!(base === "address" || base === "bool" || base === "string" || base === "bytes"
    || (integer && integer[1] === String(Number(integer[1])) && Number(integer[1]) >= 8
      && Number(integer[1]) <= 256 && Number(integer[1]) % 8 === 0)
    || (fixedBytes && fixedBytes[1] === String(Number(fixedBytes[1])) && Number(fixedBytes[1]) >= 1 && Number(fixedBytes[1]) <= 32))
    || parameter.components !== undefined) throw new Error("INVALID_DEPLOYMENT");
  return `${base}${suffix}`;
}

function parameters(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("INVALID_DEPLOYMENT");
  for (const parameter of value) parameterType(parameter);
  return value;
}

function abiKey(value: unknown): string | null {
  const entry = object(value);
  if (!["function", "event", "error", "constructor", "fallback", "receive"].includes(String(entry.type))) {
    throw new Error("INVALID_DEPLOYMENT");
  }
  if (entry.type === "fallback" || entry.type === "receive") {
    if (!(entry.stateMutability === "payable" || (entry.type === "fallback" && entry.stateMutability === "nonpayable"))) {
      throw new Error("INVALID_DEPLOYMENT");
    }
    return null;
  }
  const inputs = parameters(entry.inputs);
  if (entry.type !== "constructor" && (typeof entry.name !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entry.name))) {
    throw new Error("INVALID_DEPLOYMENT");
  }
  const signature = `${String(entry.name)}(${inputs.map((parameter) => parameterType(parameter)).join(",")})`;
  if (entry.type === "event") {
    if (typeof entry.anonymous !== "boolean" || inputs.some((parameter) => typeof parameter.indexed !== "boolean")) {
      throw new Error("INVALID_DEPLOYMENT");
    }
    const expectedNames = eventNames[String(entry.name)];
    if (expectedNames && (inputs.length !== expectedNames.length
      || inputs.some((parameter, index) => parameter.name !== expectedNames[index]))) throw new Error("INVALID_DEPLOYMENT");
    return entry.anonymous ? null : `event:${signature}:${inputs.map((parameter) => parameter.indexed ? "1" : "0").join("")}`;
  }
  if (entry.type === "error") return null;
  if (!["pure", "view", "nonpayable", "payable"].includes(String(entry.stateMutability))) throw new Error("INVALID_DEPLOYMENT");
  if (entry.type === "constructor") {
    if (!(entry.stateMutability === "nonpayable" || entry.stateMutability === "payable")) throw new Error("INVALID_DEPLOYMENT");
    return null;
  }
  if (entry.name === "payInvoice" || entry.name === "quoteInvoice") {
    const components = inputs[0]?.components;
    const expected = ["invoiceId", "merchant", "category", "amount", "expiresAt"];
    if (!Array.isArray(components) || components.some((component, index) => object(component).name !== expected[index])
      || components.length !== expected.length) throw new Error("INVALID_DEPLOYMENT");
  }
  return `function:${signature}->${parameters(entry.outputs).map((parameter) => parameterType(parameter)).join(",")}:${String(entry.stateMutability)}`;
}

function validateAbi(value: unknown, name: typeof names[number]): void {
  if (!Array.isArray(value) || value.length === 0) throw new Error("INVALID_DEPLOYMENT");
  const keys = value.map(abiKey).filter((key): key is string => key !== null);
  const signatures = keys.map((key) => key.startsWith("function:") ? key.split("->")[0] : key.slice(0, key.lastIndexOf(":")));
  if (signatures.length !== new Set(signatures).size || requiredAbi[name].some((key) => !keys.includes(key))) {
    throw new Error("INVALID_DEPLOYMENT");
  }
}

/** Browser-safe: both clients bundle the same versioned public JSON, never an RPC/key environment. */
export function getDeployment(value: unknown = manifest): Record<string, unknown> {
  const data = object(value);
  if (data.schemaVersion !== 1 || data.abiVersion !== 1 || data.chainId !== campusNetwork.chainId
    || !["unconfigured", "deployed"].includes(String(data.status))) throw new Error("INVALID_DEPLOYMENT");
  if (data.status === "unconfigured") return data;
  requireDeployment(data, { allowLocal: true });
  return data;
}

/** Consumers must opt in to local evidence explicitly; a local chain ID alone is not an L1 deployment. */
export function requireDeployment(value: unknown = manifest, { allowLocal = false } = {}): DeployedManifest {
  const data = object(value);
  if (data.status !== "deployed") throw new Error("DEPLOYMENT_NOT_CONFIGURED");
  if (data.schemaVersion !== 1 || data.abiVersion !== 1 || data.chainId !== campusNetwork.chainId
    || !(data.environment === "avalanche-l1" || (allowLocal && data.environment === "local-anvil"))) {
    throw new Error("INVALID_DEPLOYMENT");
  }
  const contracts = object(data.contracts);
  const addresses: string[] = [];
  for (const name of names) {
    const contract = object(contracts[name]);
    if (!isAddress(contract.address) || contract.abiVersion !== 1 || !isHash(contract.transactionHash)
      || !isHash(contract.blockHash) || !isHash(contract.runtimeCodeHash)
      || !Number.isSafeInteger(contract.blockNumber) || Number(contract.blockNumber) < 1) throw new Error("INVALID_DEPLOYMENT");
    validateAbi(contract.abi, name);
    addresses.push(contract.address.toLowerCase());
  }
  if (new Set(addresses).size !== names.length) throw new Error("INVALID_DEPLOYMENT");
  const roles = object(data.roles);
  const roleAddresses: string[] = [];
  for (const name of ["deployer", "sbtIssuer", "grantIssuer", "posSigner"]) {
    const role = roles[name];
    if (!isAddress(role) || addresses.includes(role.toLowerCase())) throw new Error("INVALID_DEPLOYMENT");
    roleAddresses.push(role.toLowerCase());
  }
  const merchants = object(data.merchants);
  const merchantAddresses: string[] = [];
  for (const name of ["parking", "canteen"] as const) {
    const merchant = object(merchants[name]);
    if (!isAddress(merchant.address) || !isHash(merchant.category)
      || merchant.category.toLowerCase() !== categories[name]
      || addresses.includes(merchant.address.toLowerCase()) || roleAddresses.includes(merchant.address.toLowerCase())) {
      throw new Error("INVALID_DEPLOYMENT");
    }
    merchantAddresses.push(merchant.address.toLowerCase());
  }
  if (new Set(merchantAddresses).size !== 2) throw new Error("INVALID_DEPLOYMENT");
  return data as unknown as DeployedManifest;
}

export function deploymentResponse(value: unknown = manifest): { status: number; body: unknown } {
  try {
    return { status: 200, body: requireDeployment(value) };
  } catch {
    return { status: 503, body: { status: "not-configured", chainId: campusNetwork.chainId,
      error: "DEPLOYMENT_NOT_READY" } };
  }
}
