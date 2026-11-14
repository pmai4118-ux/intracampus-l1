// Q01. Reads public payment evidence only. No wallet or transaction submission.
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { formatUnits, keccak256 } from "ethers";
import { campusNetwork } from "../packages/network/src/chain.ts";
import { requireDeployment, type DeployedManifest } from "../packages/network/src/deployment.ts";
import { assertEnvelope, isAddress, isHash, object, quantity, safeQuantity, same } from "../backend/src/modules/invoices/invoices.schema.ts";
import { readReceipt, verifyReceiptLog } from "../backend/src/modules/invoices/receipt.verifier.ts";
import { HttpInvoiceRpc, InvoiceRpcError } from "../backend/src/modules/invoices/invoices.rpc.ts";

const marks = ["request", "submit", "hash", "receipt", "apiPaid", "pos"] as const;
type Marks = Partial<Record<typeof marks[number], number>>;
const segments = {
  requestToHash: ["request", "hash"], requestToSubmit: ["request", "submit"],
  submitToReceipt: ["submit", "receipt"], hashToReceipt: ["hash", "receipt"],
  receiptToApiPaid: ["receipt", "apiPaid"], receiptToPos: ["receipt", "pos"], hashToPos: ["hash", "pos"],
} as const;
const observedStates = ["hash-observed", "rejected", "pending", "timeout", "rpc-error", "unknown", "historical"];

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown;

function readAttempt(value: unknown) {
  const row = object(value);
  const { invoiceId, txHash, payer, tier, observed } = row;
  check(isHash(invoiceId) && isAddress(payer) && (tier === 0 || tier === 1), "Invalid invoiceId, payer or expected tier");
  check(txHash === undefined || isHash(txHash), "Invalid tx hash");
  check(typeof observed === "string" && observedStates.includes(observed), "Invalid observed status");
  check(!(["hash-observed", "historical"].includes(observed) && !txHash), "Observed hash is missing");
  check(observed !== "rejected" || !txHash, "Rejected request cannot have a tx hash");
  const input = object(row.marksMs);
  const marksMs: Marks = {};
  for (const key of marks) {
    const mark = input[key];
    if (mark === undefined || mark === null) continue;
    check(Number.isSafeInteger(mark) && (mark as number) >= 0, "Invalid observation time in milliseconds");
    marksMs[key] = mark as number;
  }
  check(observed !== "historical" || !Object.keys(marksMs).length, "Historical hash has no observed timing");
  check(marksMs.hash === undefined || txHash, "Hash observation requires a tx hash");
  check(!Object.keys(input).some(key => !marks.includes(key as typeof marks[number])), "Unknown observation time");
  return { invoiceId, txHash, payer, tier, observed, marksMs, envelope: row.envelope,
    rpcReceipt: row.rpcReceipt, canonicalBlockHash: row.canonicalBlockHash,
    collectionError: row.collectionError === "RPC_UNAVAILABLE" ? "RPC_UNAVAILABLE" : undefined };
}

function readRun(value: unknown) {
  const input = object(value);
  check(input.schemaVersion === 1 && ["fixture", "local-anvil", "avalanche-l1"].includes(String(input.source)), "Invalid Q01 evidence source");
  const manifest = requireDeployment(input.manifest, { allowLocal: input.source !== "avalanche-l1" });
  check(input.source === "fixture" || manifest.environment === input.source, "Evidence and manifest environments differ");
  const context = object(input.context);
  check(typeof context.appCommit === "string" && /^[a-f0-9]{40}$/i.test(context.appCommit), "Full app commit required");
  check(typeof context.startedAt === "string" && Number.isFinite(Date.parse(context.startedAt)), "Run start time required");
  for (const key of ["network", "devices", "wallet", "clock"] as const) {
    check(typeof context[key] === "string" && context[key].length > 0, `Missing ${key} description`);
  }
  for (const key of ["posPollMs", "receiptPollMs"] as const) {
    check(context[key] === null || (Number.isSafeInteger(context[key]) && (context[key] as number) > 0), `Invalid ${key}`);
  }
  const planned = object(context.planned);
  check([planned.standard, planned.sbt].every(n => Number.isSafeInteger(n) && (n as number) >= 0), "Invalid sample plan");
  check(Array.isArray(input.attempts), "Missing attempts");
  return { schemaVersion: 1, source: String(input.source), manifest, context, attempts: input.attempts.map(readAttempt) };
}

function verify(row: ReturnType<typeof readAttempt>, manifest: DeployedManifest) {
  if (!row.txHash || row.rpcReceipt == null) {
    const status = row.collectionError ? "rpc-error"
      : ["hash-observed", "historical"].includes(row.observed) ? "pending" : row.observed;
    return { status };
  }
  try {
    const verifier = manifest.contracts.CampusPaymentRegistry;
    const receipt = readReceipt(row.rpcReceipt, row.txHash);
    check(isHash(row.canonicalBlockHash) && same(receipt.blockHash, row.canonicalBlockHash)
      && safeQuantity(receipt.blockNumber) >= verifier.blockNumber
      && same(receipt.from, row.payer) && same(receipt.to, verifier.address), "Receipt does not belong to this payment deployment");
    const envelope = row.envelope;
    assertEnvelope(envelope);
    check(same(envelope.domain.verifyingContract, verifier.address) && same(envelope.signer, manifest.roles.posSigner)
      && same(envelope.invoice.invoiceId, row.invoiceId) && same(envelope.invoice.merchant, manifest.merchants.parking.address)
      && same(envelope.invoice.category, manifest.merchants.parking.category), "Invoice does not match the measured service");
    const fee = quantity(receipt.gasUsed) * quantity(receipt.effectiveGasPrice);
    const feeFields = { feeWei: fee.toString(), feeCampus: formatUnits(fee, campusNetwork.nativeCurrency.decimals) };
    if (receipt.status === "0x0") return { status: "reverted", ...feeFields };
    const payments = (receipt.logs as unknown[]).map(log => verifyReceiptLog(envelope, receipt, log, 0)).filter(p => p !== null);
    const payment = payments[0];
    check(payments.length === 1 && payment && same(payment.payer, row.payer) && payment.tier === row.tier, "InvoicePaid does not match expected payer or tier");
    // The offline report has no B02 verification timestamp. The raw observation is separate.
    const { verifiedAt: _, ...verifiedPayment } = payment;
    return { status: "verified", ...feeFields, payment: verifiedPayment, blockHash: receipt.blockHash };
  } catch { return { status: "receipt-mismatch" }; }
}

function summarize(value: unknown) {
  const run = readRun(value);
  const invoiceIds = new Set<string>(), txHashes = new Set<string>();
  const attempts = run.attempts.map(row => {
    const id = row.invoiceId.toLowerCase(), hash = row.txHash?.toLowerCase();
    const duplicate = invoiceIds.has(id) || (hash !== undefined && txHashes.has(hash));
    invoiceIds.add(id);
    if (hash) txHashes.add(hash);
    const result = duplicate ? { status: "duplicate" } : verify(row, run.manifest);
    const error = result.status !== "verified" ? result.status
      : row.observed === "hash-observed" || row.observed === "historical" ? null : row.observed;
    const durationsMs = Object.fromEntries(Object.entries(segments).map(([name, [from, to]]) => {
      const start = row.marksMs[from], end = row.marksMs[to];
      return [name, error === null && start !== undefined && end !== undefined && end >= start ? end - start : null];
    }));
    return { invoiceId: row.invoiceId, txHash: row.txHash ?? null, tier: row.tier, observed: row.observed, ...result, error, durationsMs };
  });
  function group(tier: number) {
    const rows = attempts.filter(row => row.tier === tier);
    const verified = rows.filter(row => row.status === "verified").length;
    const errorsByStatus: Record<string, number> = {};
    for (const row of rows) {
      if (row.error !== null) errorsByStatus[row.error] = (errorsByStatus[row.error] ?? 0) + 1;
    }
    const segmentsMs = Object.fromEntries(Object.keys(segments).map(name => {
      const values = rows.map(row => row.durationsMs[name]).filter(n => n !== null).sort((a, b) => a - b);
      const n = values.length;
      return [name, { n, p50: n ? values[Math.ceil(n * 0.5) - 1] : null, p95: n ? values[Math.ceil(n * 0.95) - 1] : null }];
    }));
    return { attempted: rows.length, verified, errors: rows.filter(row => row.error !== null).length, errorsByStatus, segmentsMs };
  }
  const verifier = run.manifest.contracts.CampusPaymentRegistry;
  return { source: run.source, chainId: campusNetwork.chainId, verifier: verifier.address, deploymentTx: verifier.transactionHash,
    context: run.context, percentileMethod: "nearest-rank", groups: { standard: group(0), sbt: group(1) }, attempts };
}

async function openRpc(manifest: DeployedManifest) {
  const url = new URL(process.env.INTRACAMPUS_RPC_URL ?? "");
  const local = manifest.environment === "local-anvil";
  check(local ? url.protocol === "http:" && url.hostname === "127.0.0.1" : url.protocol === "https:", "RPC endpoint does not match the environment");
  const rpc = new HttpInvoiceRpc(url.href);
  const verifier = manifest.contracts.CampusPaymentRegistry;
  const chain = await rpc.call("eth_chainId", []);
  check(quantity(chain) === BigInt(campusNetwork.chainId), "RPC must be chain 20261");
  const client = await rpc.call("web3_clientVersion", []);
  check(typeof client === "string" && /anvil/i.test(client) === local, "RPC client does not match environment");
  const deploy = object(await rpc.call("eth_getTransactionReceipt", [verifier.transactionHash]));
  const blockTag = `0x${verifier.blockNumber.toString(16)}`;
  const block = object(await rpc.call("eth_getBlockByNumber", [blockTag, false]));
  const code = await rpc.call("eth_getCode", [verifier.address, "latest"]);
  check(deploy.status === "0x1" && same(deploy.transactionHash, verifier.transactionHash)
    && same(deploy.contractAddress, verifier.address) && safeQuantity(deploy.blockNumber) === verifier.blockNumber
    && same(deploy.blockHash, verifier.blockHash) && same(block.hash, verifier.blockHash)
    && typeof code === "string" && same(keccak256(code), verifier.runtimeCodeHash), "RPC deployment does not match manifest");
  if (!local) {
    for (const key of ["Q01_APP_URL", "Q01_API_URL"]) {
      const origin = new URL(process.env[key] ?? "");
      const loopbackApi = key === "Q01_API_URL" && origin.protocol === "http:"
        && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname);
      check((origin.protocol === "https:" || loopbackApi) && !origin.username && !origin.password,
        "Use HTTPS for app/backend, or a loopback backend on the operator machine");
      const response = await fetch(new URL("/api/deployment", origin), { signal: AbortSignal.timeout(8000), redirect: "error" });
      check(response.ok && isDeepStrictEqual(requireDeployment(await response.json()), manifest), "App/backend manifest differs from measurement manifest");
    }
  }
  return rpc;
}

async function main() {
  const [command, file, observations, output, ...extra] = process.argv.slice(2);
  if (command === "summarize" && file && !observations) {
    console.log(JSON.stringify(summarize(await readJson(file)), null, 2));
    return;
  }
  check(file && !extra.length && ((command === "check" && !observations) || (command === "collect" && observations && output)),
    "Usage: measure-payment.ts check MANIFEST | collect MANIFEST OBSERVATIONS NEW_LOG | summarize LOG");
  const manifest = requireDeployment(await readJson(file), { allowLocal: true });
  const rpc = await openRpc(manifest);
  if (command === "check") {
    console.log(JSON.stringify({ status: "ready", chainId: manifest.chainId, environment: manifest.environment,
      verifier: manifest.contracts.CampusPaymentRegistry.address }));
    return;
  }
  const input = object(await readJson(observations));
  const run = readRun({ ...input, manifest });
  check(run.source === manifest.environment, "Collection requires matching live RPC and manifest environment");
  for (const row of run.attempts) {
    // Re-read RPC for collection. Observation times always come from the recorded run.
    row.rpcReceipt = null;
    row.canonicalBlockHash = null;
    row.collectionError = undefined;
    if (!row.txHash) continue;
    try {
      row.rpcReceipt = await rpc.call("eth_getTransactionReceipt", [row.txHash]);
      if (row.rpcReceipt === null) continue;
      const receipt = readReceipt(row.rpcReceipt, row.txHash);
      const block = object(await rpc.call("eth_getBlockByNumber", [receipt.blockNumber, false]));
      row.canonicalBlockHash = block.hash;
    } catch (error) {
      if (error instanceof InvoiceRpcError) {
        row.collectionError = "RPC_UNAVAILABLE";
        row.rpcReceipt = null;
      }
    }
  }
  check(quantity(await rpc.call("eth_chainId", [])) === BigInt(campusNetwork.chainId), "RPC chain changed during collection");
  await writeFile(output, JSON.stringify(run, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(summarize(run), null, 2));
}

try { await main(); }
catch (error) {
  // URL/JSON parsing exceptions may include raw inputs; keep them out of the terminal.
  const message = error instanceof Error && !(error instanceof SyntaxError) && !(error instanceof TypeError)
    && !/(?:https?:|\bE[A-Z]{3,}\b)/.test(error.message) ? error.message : "Invalid input, RPC endpoint, or output path";
  console.error(`Q01: ${message}`);
  process.exitCode = 1;
}
