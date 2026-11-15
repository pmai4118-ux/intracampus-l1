import assert from "node:assert/strict";
import { Interface, type InterfaceAbi, type Log } from "ethers";
import { test } from "node:test";
import libraryFixture from "../../docs/fixtures/library-v1.json" with { type: "json" };
import type { DeployedLibraryDeployment } from "@intracampus/network";
import { LibraryReceiptVerifier } from "../src/modules/library/library.verifier.ts";
import type { LibraryRpcClient } from "../src/modules/library/library.rpc.ts";

const requestId = `0x${"31".repeat(32)}`;
const borrower = "0x1111111111111111111111111111111111111111";
const outsider = "0x2222222222222222222222222222222222222222";
const escrow = "0x3333333333333333333333333333333333333333";
const txHash = `0x${"41".repeat(32)}`;
const blockHash = `0x${"51".repeat(32)}`;

function setup(sender: string) {
  const iface = new Interface(libraryFixture.abi as InterfaceAbi);
  const fragment = iface.getEvent("ExpiredRefundClaimed");
  assert.ok(fragment);
  const encoded = iface.encodeEventLog(fragment, [requestId, borrower, 50_000_000_000_000_000_000n]);
  const log = { address: escrow, blockNumber: 5, blockHash, transactionHash: txHash, index: 0,
    transactionIndex: 0, removed: false, topics: encoded.topics, data: encoded.data } as unknown as Log;
  const tx = { hash: txHash, to: escrow, from: sender,
    data: iface.encodeFunctionData("claimExpiredRefund", [requestId]), value: 0n };
  const receipt = { hash: txHash, to: escrow, status: 1, blockNumber: 5, blockHash, logs: [log] };
  const rpc = {
    async getTransaction() { return tx; },
    async getTransactionReceipt() { return receipt; },
    async getBlock() { return { number: 5, timestamp: 1_800_000_000, hash: blockHash }; },
  };
  const deployment = {
    escrow: { address: escrow, abi: libraryFixture.abi },
    roles: { librarian: "0x4444444444444444444444444444444444444444" },
  } as unknown as DeployedLibraryDeployment;
  return { verifier: new LibraryReceiptVerifier(rpc as unknown as LibraryRpcClient, deployment), log };
}

test("permissionless expired-refund calls remain tied to the original borrower recipient", async () => {
  const outsiderSubmission = setup(outsider);
  const thirdPartyClaim = await outsiderSubmission.verifier.verify(outsiderSubmission.log, 10, 1_800_000_000);
  assert.equal(thirdPartyClaim?.eventName, "ExpiredRefundClaimed");
  assert.equal(thirdPartyClaim?.borrower, borrower);
  assert.equal(thirdPartyClaim?.transactionFrom, outsider);

  const borrowerSubmission = setup(borrower);
  const verified = await borrowerSubmission.verifier.verify(borrowerSubmission.log, 10, 1_800_000_000);
  assert.equal(verified?.eventName, "ExpiredRefundClaimed");
  assert.equal(verified?.transactionFrom, borrower);
});
