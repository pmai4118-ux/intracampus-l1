import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  Interface,
  Signature,
  TypedDataEncoder,
  id,
  verifyTypedData,
  zeroPadValue,
} from "ethers";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/invoice-v1.json", import.meta.url), "utf8"),
);
const invoiceDoc = readFileSync(
  new URL("../invoice-contract.md", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const apiDoc = readFileSync(
  new URL("../api-contract.md", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const { envelope, types } = fixture;
const eventAbi =
  "event InvoicePaid(bytes32 indexed invoiceId,address indexed payer,address indexed merchant,bytes32 category,uint256 originalAmount,uint256 discountAmount,uint256 paidAmount,uint8 tier)";
const abi = new Interface([eventAbi]);
const event = abi.getEvent("InvoicePaid");
const jsonExamples = (text) =>
  [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
    JSON.parse(match[1]),
  );

test("documentation JSON, QR and canonical fixture stay in agreement", () => {
  assert.deepEqual(jsonExamples(invoiceDoc)[0], envelope);
  for (const response of jsonExamples(apiDoc)) {
    if (response.envelope) assert.deepEqual(response.envelope, envelope);
    if (response.qrPayload)
      assert.deepEqual(JSON.parse(response.qrPayload), envelope);
    if (
      (response.status && response.status !== "pending") ||
      response.receipt === null
    ) {
      // The section 3.3 examples are explicitly abbreviated; expand the stored envelope.
      assert(
        Object.values(fixture.responses).some((expected) =>
          isDeepStrictEqual({ ...response, envelope }, expected),
        ),
      );
    }
  }
  assert.equal(id(envelope.meta.invoiceCode), envelope.invoice.invoiceId);
  assert.equal(id(envelope.meta.categoryCode), envelope.invoice.category);
});

for (const vector of fixture.vectors) {
  test(`EIP-712: ${vector.name}`, () => {
    const calculated = {
      domainSeparator: TypedDataEncoder.hashDomain(vector.domain),
      structHash: TypedDataEncoder.from(types).hash(vector.invoice),
      digest: TypedDataEncoder.hash(vector.domain, types, vector.invoice),
      recoveredSigner: verifyTypedData(
        vector.domain,
        types,
        vector.invoice,
        envelope.signature,
      ),
    };
    for (const [key, value] of Object.entries(calculated)) {
      assert.equal(value.toLowerCase(), vector.expected[key].toLowerCase());
      assert(
        invoiceDoc.toLowerCase().includes(value.toLowerCase()),
        `${key} missing from human-readable fixture`,
      );
    }
    assert.equal(
      calculated.recoveredSigner === envelope.signer,
      vector.expected.validSignature,
    );
  });
}

test("signature format, low-s, ABI signature and domain constants", () => {
  assert.equal(envelope.signature.length, 132);
  const signature = Signature.from(envelope.signature);
  assert([27, 28].includes(signature.v));
  assert(
    BigInt(signature.s) <=
      BigInt(
        "0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0",
      ),
  );
  for (const text of [
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    "Invoice(bytes32 invoiceId,address merchant,bytes32 category,uint256 amount,uint64 expiresAt)",
    "IntraCampusPayment",
    "1",
  ])
    assert(invoiceDoc.includes(id(text)));
  assert.equal(
    event.topicHash,
    id(
      "InvoicePaid(bytes32,address,address,bytes32,uint256,uint256,uint256,uint8)",
    ),
  );
  assert(
    invoiceDoc.includes(
      "function posSigner() external view returns (address);",
    ),
  );
});

// These small reference checks evaluate normative scenario fixtures. They are NOT B02/U04 implementations.
function referenceReceiptCheck(log) {
  if (
    log.address.toLowerCase() !==
      envelope.domain.verifyingContract.toLowerCase() ||
    log.topics.length !== 4 ||
    log.data.length !== 2 + 5 * 64 ||
    log.topics[0] !== event.topicHash ||
    log.topics[1] !== envelope.invoice.invoiceId ||
    log.topics[3].toLowerCase() !==
      zeroPadValue(envelope.invoice.merchant, 32).toLowerCase()
  )
    return false;
  try {
    const parsed = abi.parseLog(log).args;
    if (parsed.tier !== 0n && parsed.tier !== 1n) return false;
    const expectedDiscount =
      parsed.tier === 1n ? (parsed.originalAmount * 1000n) / 10000n : 0n;
    return (
      parsed.category === envelope.invoice.category &&
      parsed.originalAmount === BigInt(envelope.invoice.amount) &&
      parsed.discountAmount === expectedDiscount &&
      parsed.paidAmount === parsed.originalAmount - expectedDiscount
    );
  } catch {
    return false;
  }
}

function receiptLog(row) {
  return {
    address: envelope.domain.verifyingContract,
    ...abi.encodeEventLog(event, [
      envelope.invoice.invoiceId,
      fixture.responses.paid.receipt.payer,
      envelope.invoice.merchant,
      envelope.invoice.category,
      row.originalAmount,
      row.discountAmount,
      row.paidAmount,
      row.tier,
    ]),
  };
}

for (const row of fixture.receiptCases) {
  test(`receipt fixture: ${row.name}`, () => {
    const log = receiptLog(row);
    assert.equal(typeof abi.parseLog(log).args.tier, "bigint");
    assert.equal(referenceReceiptCheck(log), row.accepted);
  });
}

test("receipt rejects wrong contract, topic, invoice, merchant, category and malformed ABI", () => {
  const valid = receiptLog(fixture.receiptCases[0]);
  const zero = `0x${"00".repeat(32)}`;
  const other = "0x0000000000000000000000000000000000099999";
  assert.equal(referenceReceiptCheck({ ...valid, address: other }), false);
  for (const index of [0, 1, 3]) {
    const topics = [...valid.topics];
    topics[index] = zero;
    assert.equal(referenceReceiptCheck({ ...valid, topics }), false);
  }
  assert.equal(
    referenceReceiptCheck({ ...valid, topics: valid.topics.slice(0, 3) }),
    false,
  );
  assert.equal(referenceReceiptCheck({ ...valid, data: "0x" }), false);
  assert.equal(
    referenceReceiptCheck({ ...valid, data: zero + valid.data.slice(66) }),
    false,
  );
});

test("price fixtures use integer floor division, including sub-CAMPUS amounts", () => {
  for (const row of fixture.pricingCases) {
    const amount = BigInt(row.amount);
    const discount = row.tier === 1 ? (amount * 1000n) / 10000n : 0n;
    assert.equal(discount.toString(), row.discountAmount);
    assert.equal((amount - discount).toString(), row.paidAmount);
  }
});

function referencePreflight(row) {
  if (!row.rpcAvailable) return "RPC_UNAVAILABLE";
  if (row.invoicePaid) return "INVOICE_ALREADY_PAID";
  if (row.chainTimestamp > envelope.invoice.expiresAt) return "INVOICE_EXPIRED";
  return (
    {
      InvoiceExpired: "INVOICE_EXPIRED",
      InvoiceAlreadyPaid: "INVOICE_ALREADY_PAID",
      IncorrectPaymentAmount: "INCORRECT_PAYMENT_AMOUNT",
    }[row.simulation] ?? "OK"
  );
}

for (const row of fixture.preflightCases) {
  test(`preflight policy fixture: ${row.name}`, () => {
    assert.equal(referencePreflight(row), row.expectedCode);
    assert.equal(
      referencePreflight({
        ...row,
        localTimestamp: row.localTimestamp + 86400,
      }),
      row.expectedCode,
    );
  });
}

function referenceLookup(row) {
  if (row.cachedPaid || (row.rpcAvailable && row.canonicalPaid))
    return [200, "paid", "confirmed"];
  if (!row.rpcAvailable) return [503, "rpc-error", row.txOutcome];
  const status =
    row.chainTimestamp > envelope.invoice.expiresAt ? "expired" : "pending";
  return [
    ["reverted", "event-mismatch"].includes(row.txOutcome) ? 422 : 200,
    status,
    row.txOutcome,
  ];
}

for (const row of fixture.lookupCases) {
  test(`lookup policy fixture: ${row.name}`, () => {
    assert.deepEqual(referenceLookup(row), [
      row.expectedHttp,
      row.expectedStatus,
      row.expectedTransaction,
    ]);
  });
}

test("full response fixtures have coherent lifecycle, transaction and error shapes", () => {
  for (const [name, response] of Object.entries(fixture.responses)) {
    assert.deepEqual(response.envelope, envelope);
    assert.equal(response.invoiceId, envelope.invoice.invoiceId);
    assert.equal(response.status === "paid", response.receipt !== null);
    if (response.status === "paid") {
      assert.equal(response.transaction.status, "confirmed");
      assert.equal(response.transaction.txHash, response.receipt.txHash);
    }
    if (response.status === "rpc-error")
      assert([null, "pending", "expired"].includes(response.lastKnownStatus));
    if (response.transaction)
      assert.match(response.transaction.txHash, /^0x[0-9a-fA-F]{64}$/);
    if (response.error)
      for (const field of ["code", "message", "retryable", "nextStep"]) {
        assert(Object.hasOwn(response.error, field), `${name}.${field}`);
      }
  }
});
