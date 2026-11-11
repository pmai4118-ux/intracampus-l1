// L04 evidence on a fresh local Anvil EVM. Uses unlocked synthetic accounts only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractFactory, Interface, JsonRpcProvider, id } from "ethers";
import { loadVerifiedArtifact } from "./load-verified-artifact.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = JSON.parse(await readFile(join(root, "docs/fixtures/invoice-v1.json"), "utf8"));
const artifact = (name) => loadVerifiedArtifact(join(root, "contracts"), name);
const paymentArtifact = await artifact("CampusPaymentRegistry");
const identityArtifact = await artifact("StudentSBTIdentity");
const actualAbi = new Interface(paymentArtifact.abi);
const expectedAbi = new Interface([
  "event InvoicePaid(bytes32 indexed invoiceId,address indexed payer,address indexed merchant,bytes32 category,uint256 originalAmount,uint256 discountAmount,uint256 paidAmount,uint8 tier)",
  "function posSigner() view returns (address)",
  "function quoteInvoice((bytes32 invoiceId,address merchant,bytes32 category,uint256 amount,uint64 expiresAt) invoice,address payer) view returns (uint8 tier,uint256 discountAmount,uint256 paidAmount)",
  "function payInvoice((bytes32 invoiceId,address merchant,bytes32 category,uint256 amount,uint64 expiresAt) invoice,bytes signature) payable",
  "function isInvoicePaid(bytes32 invoiceId) view returns (bool)",
  "error InvoiceExpired(bytes32 invoiceId,uint64 expiresAt,uint256 currentTimestamp)",
  "error InvoiceAlreadyPaid(bytes32 invoiceId)",
  "error InvalidSignature(address recoveredSigner,address expectedSigner)",
  "error InvalidMerchantOrCategory(address merchant,bytes32 category)",
  "error IncorrectPaymentAmount(uint256 sentValue,uint256 requiredAmount)",
  "error MerchantTransferFailed(address merchant,uint256 amount)",
]);
for (const expected of expectedAbi.fragments) {
  const getter = expected.type === "event" ? "getEvent" : expected.type === "error" ? "getError" : "getFunction";
  const actual = actualAbi[getter](expected.format("sighash"));
  assert(actual, `Missing P02 ${expected.type}: ${expected.name}`);
  // Includes event indexing, argument types, outputs, and function mutability; names are checked for InvoicePaid below.
  assert.equal(actual.format("full"), expected.format("full"), `P02 ABI differs: ${expected.name}`);
}

const server = createServer();
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
await new Promise((done) => server.close(done));
const anvil = spawn(process.env.ANVIL_BIN ?? "anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "20261", "--silent"],
  { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
let processError;
let stderr = "";
anvil.on("error", (error) => { processError = error; });
anvil.stderr.on("data", (data) => { stderr += data; });
const cleanup = () => { anvil.kill(); };
process.once("exit", cleanup);
const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 20261, { staticNetwork: true, cacheTimeout: -1 });
provider.pollingInterval = 50;

try {
  let version;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (processError) throw processError;
    if (anvil.exitCode !== null) throw new Error(`Anvil exited: ${stderr}`);
    try { version = await provider.send("web3_clientVersion", []); break; } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  assert.match(version ?? "", /anvil/i, "Local Anvil failed to start");
  assert.equal(BigInt(await provider.send("eth_chainId", [])), 20261n);
  const [admin, posSigner, standard, student, merchant] = await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));
  const addresses = await Promise.all([admin, posSigner, standard, student, merchant].map((wallet) => wallet.getAddress()));
  const identity = await new ContractFactory(identityArtifact.abi, identityArtifact.bytecode.object, admin).deploy(addresses[0]);
  await identity.waitForDeployment();
  const payment = await new ContractFactory(paymentArtifact.abi, paymentArtifact.bytecode.object, admin)
    .deploy(addresses[0], addresses[1], await identity.getAddress());
  await payment.waitForDeployment();
  const category = fixture.envelope.invoice.category;
  await (await payment.setMerchantCategory(addresses[4], category, true)).wait();
  const startTime = (await provider.getBlock("latest")).timestamp;
  await (await identity.mint(addresses[3], startTime + 3600)).wait();
  assert.equal(await payment.posSigner(), addresses[1]);
  const merchantBefore = await provider.getBalance(addresses[4]);
  const receipts = [];
  const domain = { name: "IntraCampusPayment", version: "1", chainId: 20261, verifyingContract: await payment.getAddress() };

  for (const [name, wallet, payer, tier] of [["standard", standard, addresses[2], 0n], ["student", student, addresses[3], 1n]]) {
    const amount = BigInt(fixture.envelope.invoice.amount);
    const discount = tier === 1n ? amount / 10n : 0n;
    const invoice = { invoiceId: id(`L04-local-${name}`), merchant: addresses[4], category, amount,
      expiresAt: (await provider.getBlock("latest")).timestamp + 300 };
    const signature = await posSigner.signTypedData(domain, fixture.types, invoice);
    const quote = await payment.quoteInvoice(invoice, payer);
    assert.deepEqual([...quote], [tier, discount, amount - discount]);
    const connected = payment.connect(wallet);
    await connected.payInvoice.staticCall(invoice, signature, { value: quote[2] });
    const receipt = await (await connected.payInvoice(invoice, signature, { value: quote[2] })).wait();
    assert.equal(receipt.status, 1);
    assert.equal(receipt.to, await payment.getAddress());
    const log = receipt.logs.find((entry) => entry.address === receipt.to && entry.topics[0] === actualAbi.getEvent("InvoicePaid").topicHash);
    assert(log, "Missing event from expected contract");
    const decoded = actualAbi.parseLog(log);
    assert.deepEqual([...decoded.args], [invoice.invoiceId, payer, addresses[4], category, amount, discount, amount - discount, tier]);
    assert.equal(await payment.isInvoicePaid(invoice.invoiceId), true);
    await assert.rejects(connected.payInvoice.staticCall(invoice, signature, { value: quote[2] }),
      (error) => actualAbi.parseError(error.data)?.name === "InvoiceAlreadyPaid");
    receipts.push({ name, invoice, verifiedEvent: decoded.args.toObject(), receipt: receipt.toJSON() });
  }
  assert.equal((await provider.getBalance(addresses[4])) - merchantBefore, 5700n * 10n ** 18n);
  assert.equal(await provider.getBalance(await payment.getAddress()), 0n);
  const output = resolve(process.argv[2] ?? join(tmpdir(), "intracampus-l04-local-receipts.json"));
  await mkdir(dirname(output), { recursive: true });
  const sourceSha256 = {};
  for (const path of ["contracts/src/CampusPaymentRegistry.sol", "contracts/src/StudentSBTIdentity.sol",
    "contracts/lib/openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol"]) {
    const source = (await readFile(join(root, path), "utf8")).replaceAll("\r\n", "\n");
    sourceSha256[path] = createHash("sha256").update(source).digest("hex");
  }
  await writeFile(output, JSON.stringify({ evidence: "Local Anvil EVM only; not Avalanche L1 receipts", generatedAt: new Date().toISOString(),
    sourceHashNormalization: "UTF-8 with LF line endings", sourceSha256,
    client: version, chainId: 20261, deployment: { studentSbt: await identity.getAddress(), paymentRegistry: await payment.getAddress(),
      admin: addresses[0], posSigner: addresses[1], merchant: addresses[4] },
    invoicePaidAbi: actualAbi.getEvent("InvoicePaid").format("full"), receipts },
  (_, value) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");
  console.log(`L04 local EVM: P02 ABI matched; standard/student receipts verified; replay rejected.\nEvidence: ${output}`);
} finally {
  provider.destroy();
  cleanup();
  process.removeListener("exit", cleanup);
}
