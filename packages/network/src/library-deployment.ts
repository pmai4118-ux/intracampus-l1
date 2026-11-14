import manifest from "../../../deployments/intracampus.json" with { type: "json" };
import libraryFixture from "../../../docs/fixtures/library-v1.json" with { type: "json" };
import { campusNetwork } from "./chain.ts";
import { requireDeployment, type DeployedManifest, type PublicContract } from "./deployment.ts";

const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const maxUint256 = BigInt(2) ** BigInt(256) - BigInt(1);

type LibraryFixtureData = {
  abi: Record<string, unknown>[];
  policy: {
    depositWei: string;
    approvalWindowSeconds: number;
    loanDurationSeconds: number;
    gracePeriodSeconds: number;
    lateFeeIntervalSeconds: number;
    lateFeePerIntervalWei: string;
    maxLateFeeWei: string;
    fullDepositRetentionAfterSeconds: number;
  };
};

// The committed fixture is the reviewed ABI and policy contract shared with the exporter.
const fixture = libraryFixture as unknown as LibraryFixtureData;

export type LibraryDeploymentEnvironment = "avalanche-l1" | "local-anvil";

export type LibraryDeploymentPolicy = {
  depositWei: string;
  approvalWindowSeconds: number;
  loanDurationSeconds: number;
  gracePeriodSeconds: number;
  lateFeeIntervalSeconds: number;
  lateFeePerIntervalWei: string;
  maxLateFeeWei: string;
  fullDepositRetentionAfterSeconds: number;
};

const policySpec: LibraryDeploymentPolicy = {
  depositWei: String(fixture.policy.depositWei),
  approvalWindowSeconds: fixture.policy.approvalWindowSeconds,
  loanDurationSeconds: fixture.policy.loanDurationSeconds,
  gracePeriodSeconds: fixture.policy.gracePeriodSeconds,
  lateFeeIntervalSeconds: fixture.policy.lateFeeIntervalSeconds,
  lateFeePerIntervalWei: String(fixture.policy.lateFeePerIntervalWei),
  maxLateFeeWei: String(fixture.policy.maxLateFeeWei),
  fullDepositRetentionAfterSeconds: fixture.policy.fullDepositRetentionAfterSeconds,
};

export type LibraryBookTerms = {
  bookId: string;
  depositWei: string;
  replacementPriceWei: string;
  sealed: true;
};

export type LibrarySeedTransaction = {
  type: "seedBookTerms" | "sealBookTerms";
  bookId: string;
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
};

export type UnconfiguredLibraryDeployment = {
  schemaVersion: 1;
  status: "unconfigured";
  chainId: typeof campusNetwork.chainId;
  abiVersion: 1;
  environment: null;
  escrow: {
    address: null;
    abiVersion: 1;
    abi: Record<string, unknown>[];
    transactionHash: null;
    blockNumber: null;
    blockHash: null;
    runtimeCodeHash: null;
  } | null;
  roles: null;
  treasury: null;
  policy: LibraryDeploymentPolicy;
  books: [];
  seedTransactions: [];
};

export type DeployedLibraryDeployment = {
  schemaVersion: 1;
  status: "deployed";
  chainId: typeof campusNetwork.chainId;
  abiVersion: 1;
  environment: LibraryDeploymentEnvironment;
  generatedAt?: string;
  verifiedAt: { blockNumber: number; blockHash: string };
  escrow: PublicContract;
  roles: { deployer: string; administrator: string; librarian: string };
  treasury: string;
  policy: LibraryDeploymentPolicy;
  books: LibraryBookTerms[];
  seedTransactions: LibrarySeedTransaction[];
};

export type LibraryDeployment = UnconfiguredLibraryDeployment | DeployedLibraryDeployment;
export type LibraryDeployedManifest = {
  schemaVersion: 1;
  status: "deployed";
  chainId: typeof campusNetwork.chainId;
  abiVersion: 1;
  environment: LibraryDeploymentEnvironment;
  library: DeployedLibraryDeployment;
  contracts?: DeployedManifest["contracts"];
  roles?: DeployedManifest["roles"];
  merchants?: DeployedManifest["merchants"];
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

function isBlockNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function libraryAbiEntry(value: unknown): string {
  const entry = object(value);
  const inputs = abiParameters(entry.inputs ?? []);
  const outputs = abiParameters(entry.outputs ?? []);
  const signature = `${String(entry.name ?? "constructor")}(${inputs.map((parameter) => String(parameter.type)).join(",")})`;
  const inputDescription = inputs.map((parameter) => {
    const name = parameter.name ?? "";
    if (typeof name !== "string") throw new Error("INVALID_DEPLOYMENT");
    return `${name}:${String(parameter.type)}${parameter.indexed ? ":indexed" : ""}`;
  }).join("|");
  const outputDescription = outputs.map((parameter) => {
    const name = parameter.name ?? "";
    if (typeof name !== "string") throw new Error("INVALID_DEPLOYMENT");
    return `${name}:${String(parameter.type)}`;
  }).join("|") || "-";

  if (entry.type === "constructor") return `constructor ${signature}:${String(entry.stateMutability)}:inputs(${inputDescription})`;
  if (entry.type === "function") return `function ${signature}:${String(entry.stateMutability)}:inputs(${inputDescription}):outputs(${outputDescription})`;
  if (entry.type === "event") {
    if (typeof entry.anonymous !== "boolean" || inputs.some((parameter) => typeof parameter.indexed !== "boolean")) {
      throw new Error("INVALID_DEPLOYMENT");
    }
    return `event ${signature}:anonymous=${entry.anonymous}:inputs(${inputDescription})`;
  }
  if (entry.type === "error") return `error ${signature}:inputs(${inputDescription})`;
  throw new Error("INVALID_DEPLOYMENT");
}

function abiParameters(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("INVALID_DEPLOYMENT");
  return value.map((item) => {
    const parameter = object(item);
    if (typeof parameter.type !== "string") throw new Error("INVALID_DEPLOYMENT");
    return parameter;
  });
}

const expectedLibraryAbi = fixture.abi.map(libraryAbiEntry).sort();

function validateLibraryAbi(value: unknown): void {
  if (!Array.isArray(value) || value.length !== expectedLibraryAbi.length) throw new Error("INVALID_DEPLOYMENT");
  const actual = value.map(libraryAbiEntry).sort();
  if (actual.some((entry, index) => entry !== expectedLibraryAbi[index])) throw new Error("INVALID_DEPLOYMENT");
}

function validatePolicy(value: unknown): LibraryDeploymentPolicy {
  const policy = object(value);
  for (const [key, expected] of Object.entries(policySpec)) {
    if (policy[key] !== expected) throw new Error("INVALID_DEPLOYMENT");
  }
  return policy as unknown as LibraryDeploymentPolicy;
}

function unconfiguredLibrary(): UnconfiguredLibraryDeployment {
  return {
    schemaVersion: 1,
    status: "unconfigured",
    chainId: campusNetwork.chainId,
    abiVersion: 1,
    environment: null,
    escrow: null,
    roles: null,
    treasury: null,
    policy: { ...policySpec },
    books: [],
    seedTransactions: [],
  };
}

function validateUnconfiguredLibrary(value: unknown): UnconfiguredLibraryDeployment {
  const library = object(value);
  if (library.schemaVersion !== 1 || library.status !== "unconfigured"
    || library.chainId !== campusNetwork.chainId || library.abiVersion !== 1
    || library.environment !== null || library.roles !== null || library.treasury !== null) {
    throw new Error("INVALID_DEPLOYMENT");
  }
  validatePolicy(library.policy);
  if (!Array.isArray(library.books) || library.books.length !== 0
    || !Array.isArray(library.seedTransactions) || library.seedTransactions.length !== 0) {
    throw new Error("INVALID_DEPLOYMENT");
  }
  if (library.escrow !== null) {
    const escrow = object(library.escrow);
    if (escrow.address !== null || escrow.abiVersion !== 1 || escrow.transactionHash !== null
      || escrow.blockNumber !== null || escrow.blockHash !== null || escrow.runtimeCodeHash !== null) {
      throw new Error("INVALID_DEPLOYMENT");
    }
    validateLibraryAbi(escrow.abi);
  }
  return library as unknown as UnconfiguredLibraryDeployment;
}

function collectBaseAddresses(data: Record<string, unknown>): Set<string> {
  const addresses = new Set<string>();
  for (const groupValue of [data.contracts, data.merchants]) {
    if (!groupValue || typeof groupValue !== "object" || Array.isArray(groupValue)) continue;
    for (const itemValue of Object.values(groupValue)) {
      if (!itemValue || typeof itemValue !== "object" || Array.isArray(itemValue)) continue;
      const address = (itemValue as Record<string, unknown>).address;
      if (isAddress(address)) addresses.add(address.toLowerCase());
    }
  }
  if (data.roles && typeof data.roles === "object" && !Array.isArray(data.roles)) {
    for (const role of Object.values(data.roles)) {
      if (isAddress(role)) addresses.add(role.toLowerCase());
    }
  }
  return addresses;
}

function validateDeployedLibrary(
  value: unknown,
  data: Record<string, unknown>,
  allowLocal: boolean,
): DeployedLibraryDeployment {
  const library = object(value);
  const environment = library.environment;
  if (library.schemaVersion !== 1 || library.status !== "deployed"
    || library.chainId !== campusNetwork.chainId || library.abiVersion !== 1
    || !(environment === "avalanche-l1" || (allowLocal && environment === "local-anvil"))
    || data.environment !== environment) {
    throw new Error("INVALID_DEPLOYMENT");
  }

  const verifiedAt = object(library.verifiedAt);
  if (!isBlockNumber(verifiedAt.blockNumber) || !isHash(verifiedAt.blockHash)) throw new Error("INVALID_DEPLOYMENT");

  const escrow = object(library.escrow);
  if (!isAddress(escrow.address) || escrow.abiVersion !== 1 || !isHash(escrow.transactionHash)
    || !isHash(escrow.blockHash) || !isHash(escrow.runtimeCodeHash) || !isBlockNumber(escrow.blockNumber)) {
    throw new Error("INVALID_DEPLOYMENT");
  }
  validateLibraryAbi(escrow.abi);

  const baseAddresses = collectBaseAddresses(data);
  const escrowAddress = escrow.address.toLowerCase();
  if (baseAddresses.has(escrowAddress)) throw new Error("INVALID_DEPLOYMENT");

  const roles = object(library.roles);
  const roleAddresses: string[] = [];
  for (const name of ["deployer", "administrator", "librarian"] as const) {
    const role = roles[name];
    if (!isAddress(role) || role.toLowerCase() === escrowAddress) throw new Error("INVALID_DEPLOYMENT");
    roleAddresses.push(role.toLowerCase());
  }
  if (!isAddress(library.treasury)) throw new Error("INVALID_DEPLOYMENT");
  const treasury = library.treasury.toLowerCase();
  if (treasury === escrowAddress || roleAddresses.includes(treasury) || baseAddresses.has(treasury)) {
    throw new Error("INVALID_DEPLOYMENT");
  }

  const policy = validatePolicy(library.policy);
  if (!Array.isArray(library.books) || library.books.length === 0) throw new Error("INVALID_DEPLOYMENT");
  const books = new Map<string, { seedBookTerms: boolean; sealBookTerms: boolean }>();
  for (const item of library.books) {
    const book = object(item);
    if (!isHash(book.bookId) || book.depositWei !== policy.depositWei
      || typeof book.replacementPriceWei !== "string" || book.replacementPriceWei.length > 78
      || !positiveIntegerPattern.test(book.replacementPriceWei) || BigInt(book.replacementPriceWei) > maxUint256
      || book.sealed !== true) {
      throw new Error("INVALID_DEPLOYMENT");
    }
    const bookId = book.bookId.toLowerCase();
    if (books.has(bookId)) throw new Error("INVALID_DEPLOYMENT");
    books.set(bookId, { seedBookTerms: false, sealBookTerms: false });
  }

  if (!Array.isArray(library.seedTransactions) || library.seedTransactions.length !== books.size * 2) {
    throw new Error("INVALID_DEPLOYMENT");
  }
  const transactionHashes = new Set([escrow.transactionHash.toLowerCase()]);
  let latestEvidenceBlock = Number(escrow.blockNumber);
  for (const item of library.seedTransactions) {
    const transaction = object(item);
    if (!(transaction.type === "seedBookTerms" || transaction.type === "sealBookTerms")
      || !isHash(transaction.bookId) || !isHash(transaction.transactionHash)
      || !isHash(transaction.blockHash) || !isBlockNumber(transaction.blockNumber)) {
      throw new Error("INVALID_DEPLOYMENT");
    }
    const bookId = transaction.bookId.toLowerCase();
    const coverage = books.get(bookId);
    const transactionHash = transaction.transactionHash.toLowerCase();
    if (!coverage || coverage[transaction.type] || transactionHashes.has(transactionHash)) {
      throw new Error("INVALID_DEPLOYMENT");
    }
    coverage[transaction.type] = true;
    transactionHashes.add(transactionHash);
    latestEvidenceBlock = Math.max(latestEvidenceBlock, Number(transaction.blockNumber));
  }
  if ([...books.values()].some((coverage) => !coverage.seedBookTerms || !coverage.sealBookTerms)
    || Number(verifiedAt.blockNumber) < latestEvidenceBlock) {
    throw new Error("INVALID_DEPLOYMENT");
  }

  return library as unknown as DeployedLibraryDeployment;
}

/** Browser-safe lookup; old three-contract manifests yield an explicit unconfigured Library view. */
export function getLibraryDeployment(value: unknown = manifest): LibraryDeployment {
  const data = object(value);
  if (data.schemaVersion !== 1 || data.abiVersion !== 1 || data.chainId !== campusNetwork.chainId
    || !(data.status === "unconfigured" || data.status === "deployed")) {
    throw new Error("INVALID_DEPLOYMENT");
  }
  if (data.library === undefined || data.library === null) return unconfiguredLibrary();

  const library = object(data.library);
  if (library.status === "unconfigured") return validateUnconfiguredLibrary(library);
  if (library.status !== "deployed") throw new Error("INVALID_DEPLOYMENT");
  requireLibraryDeployment(data, { allowLocal: true });
  return library as unknown as DeployedLibraryDeployment;
}

/** Require a verified escrow extension; local-anvil evidence must be opted into explicitly. */
export function requireLibraryDeployment(
  value: unknown = manifest,
  { allowLocal = false }: { allowLocal?: boolean } = {},
): LibraryDeployedManifest {
  const data = object(value);
  if (data.library === undefined || data.library === null) throw new Error("LIBRARY_NOT_CONFIGURED");
  const library = object(data.library);
  if (library.status !== "deployed") throw new Error("LIBRARY_NOT_CONFIGURED");
  if (data.contracts !== undefined || data.roles !== undefined || data.merchants !== undefined) {
    requireDeployment(data, { allowLocal });
  } else if (data.schemaVersion !== 1 || data.abiVersion !== 1 || data.chainId !== campusNetwork.chainId
    || data.status !== "deployed"
    || !(data.environment === "avalanche-l1" || (allowLocal && data.environment === "local-anvil"))) {
    throw new Error("INVALID_DEPLOYMENT");
  }
  validateDeployedLibrary(library, data, allowLocal);
  return data as unknown as LibraryDeployedManifest;
}