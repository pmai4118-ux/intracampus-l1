import { CAMPUS_CHAIN_ID } from "@intracampus/network";
import { Interface, type InterfaceAbi, type Log } from "ethers";
import type { DeployedLibraryDeployment } from "@intracampus/network";
import type { LibraryVerifiedChainEvent } from "./library.types.ts";
import { LibraryRpcError, type LibraryRpcClient } from "./library.rpc.ts";

const eventAction: Record<string, string> = {
  DepositReceived: "deposit",
  LoanApproved: "approve",
  RequestRejected: "reject",
  ExpiredRefundClaimed: "claimExpiredRefund",
  PhysicalReturnConfirmed: "confirmPhysicalReturn",
  ReturnSettled: "settleReturn",
  LostSettled: "settleLost",
  ShortfallPaid: "payShortfall",
};

function same(left: unknown, right: string): boolean {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

function number(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new LibraryRpcError();
  return result;
}

function decimal(value: unknown): string {
  try {
    const result = BigInt(value as bigint);
    if (result < 0n) throw new Error();
    return result.toString();
  } catch { throw new LibraryRpcError(); }
}

function actionForEvent(name: string): string {
  const action = eventAction[name];
  if (!action) throw new LibraryRpcError();
  return action;
}

export class LibraryReceiptVerifier {
  readonly iface: Interface;
  private readonly rpc: LibraryRpcClient;
  private readonly deployment: DeployedLibraryDeployment;
  constructor(rpc: LibraryRpcClient, deployment: DeployedLibraryDeployment) {
    this.rpc = rpc;
    this.deployment = deployment;
    this.iface = new Interface(deployment.escrow.abi as InterfaceAbi);
  }

  lifecycleTopics(): string[] {
    return Object.keys(eventAction).map((name) => {
      const fragment = this.iface.getEvent(name);
      if (!fragment) throw new LibraryRpcError();
      return fragment.topicHash;
    });
  }

  async verify(log: Log, safeHead: number, observedAt: number): Promise<LibraryVerifiedChainEvent | null> {
    const escrow = this.deployment.escrow.address.toLowerCase();
    if (log.removed || log.address.toLowerCase() !== escrow) throw new LibraryRpcError();
    if (log.blockNumber > safeHead) return null;
    let parsedLog;
    try { parsedLog = this.iface.parseLog({ topics: [...log.topics], data: log.data }); }
    catch { throw new LibraryRpcError(); }
    if (!parsedLog || !Object.hasOwn(eventAction, parsedLog.name)) return null;
    // Reconciliation limits verification to 16 logs per wave, so even deposits stay below the provider's 100-call JSON-RPC batch cap.
    const depositBookId = parsedLog.name === "DepositReceived" ? String(parsedLog.args[2]).toLowerCase() : undefined;
    const termsPromise = depositBookId
      ? this.rpc.call({ to: escrow, data: this.iface.encodeFunctionData("bookTerms", [depositBookId]) }, safeHead)
      : Promise.resolve(undefined);
    const [tx, receipt, block, rawTerms] = await Promise.all([
      this.rpc.getTransaction(log.transactionHash),
      this.rpc.getTransactionReceipt(log.transactionHash),
      this.rpc.getBlock(log.blockNumber),
      termsPromise,
    ]);
    if (!tx || !receipt || !block || receipt.status !== 1 || receipt.blockNumber !== log.blockNumber
      || !same(tx.to, escrow) || !same(receipt.to, escrow) || !same(receipt.hash, log.transactionHash)
      || !same(receipt.blockHash, log.blockHash) || !same(block.hash, log.blockHash)) throw new LibraryRpcError();

    const expectedLogs = receipt.logs.flatMap((candidate) => {
      if (candidate.address.toLowerCase() !== escrow) return [];
      try {
        const parsed = this.iface.parseLog({ topics: [...candidate.topics], data: candidate.data });
        return parsed && Object.hasOwn(eventAction, parsed.name) ? [{ candidate, parsed }] : [];
      } catch { return []; }
    });
    const exact = expectedLogs.filter(({ candidate, parsed }) => candidate.index === log.index && parsed.name === parsedLog.name
      && candidate.transactionHash.toLowerCase() === log.transactionHash.toLowerCase());
    if (expectedLogs.length !== 1 || exact.length !== 1) throw new LibraryRpcError();

    let txCall;
    try { txCall = this.iface.parseTransaction({ data: tx.data, value: tx.value }); }
    catch { throw new LibraryRpcError(); }
    const expectedCall = actionForEvent(parsedLog.name);
    if (!txCall || txCall.name !== expectedCall || !same(txCall.args[0], String(parsedLog.args[0]))) throw new LibraryRpcError();
    const requestId = String(parsedLog.args[0]).toLowerCase();
    const borrower = String(parsedLog.args[1]).toLowerCase();
    const actor = tx.from.toLowerCase();
    if (["LoanApproved", "RequestRejected", "PhysicalReturnConfirmed", "ReturnSettled", "LostSettled"].includes(parsedLog.name)
      && actor !== this.deployment.roles.librarian.toLowerCase()) throw new LibraryRpcError();
    if (["DepositReceived", "ShortfallPaid"].includes(parsedLog.name) && actor !== borrower) throw new LibraryRpcError();

    const common = { chainId: CAMPUS_CHAIN_ID, contractAddress: escrow, txHash: log.transactionHash.toLowerCase(),
      logIndex: log.index, blockNumber: log.blockNumber, blockHash: log.blockHash.toLowerCase(), blockTimestamp: block.timestamp,
      transactionFrom: actor, observedAt };
    const args = parsedLog.args;
    switch (parsedLog.name) {
      case "DepositReceived": {
        const bookId = String(args[2]).toLowerCase();
        if (!same(txCall.args[1], bookId) || tx.value !== BigInt(decimal(args[3]))) throw new LibraryRpcError();
        if (rawTerms === undefined) throw new LibraryRpcError();
        const [depositWei, replacementPriceWei, isSealed] = this.iface.decodeFunctionResult("bookTerms", rawTerms);
        const seeded = this.deployment.books.find((book) => book.bookId.toLowerCase() === bookId);
        const amount = decimal(args[3]);
        if (!seeded || isSealed !== true || decimal(depositWei) !== amount
          || decimal(replacementPriceWei) !== seeded.replacementPriceWei) throw new LibraryRpcError();
        const depositedAt = number(args[4]);
        if (depositedAt !== block.timestamp) throw new LibraryRpcError();
        return { ...common, eventName: "DepositReceived", requestId, borrower, bookId, amountWei: amount,
          depositedAt, approvalDeadline: depositedAt + this.deployment.policy.approvalWindowSeconds };
      }
      case "LoanApproved": {
        const approvedAt = number(args[2]), dueAt = number(args[3]);
        if (approvedAt !== block.timestamp || dueAt !== approvedAt + this.deployment.policy.loanDurationSeconds
          || decimal(tx.value) !== "0") throw new LibraryRpcError();
        return { ...common, eventName: "LoanApproved", requestId, borrower, approvedAt, dueAt, replacementPriceWei: decimal(args[4]) };
      }
      case "RequestRejected":
        if (decimal(tx.value) !== "0") throw new LibraryRpcError();
        return { ...common, eventName: "RequestRejected", requestId, borrower, refundWei: decimal(args[2]) };
      case "ExpiredRefundClaimed":
        if (decimal(tx.value) !== "0") throw new LibraryRpcError();
        return { ...common, eventName: "ExpiredRefundClaimed", requestId, borrower, refundWei: decimal(args[2]) };
      case "PhysicalReturnConfirmed": {
        const returnedAt = number(args[2]);
        if (returnedAt !== block.timestamp || decimal(tx.value) !== "0") throw new LibraryRpcError();
        return { ...common, eventName: "PhysicalReturnConfirmed", requestId, borrower, returnedAt };
      }
      case "ReturnSettled":
        if (decimal(tx.value) !== "0") throw new LibraryRpcError();
        return { ...common, eventName: "ReturnSettled", requestId, borrower, returnedAt: number(args[2]),
          lateFeeWei: decimal(args[3]), repairFeeWei: decimal(args[4]), overdueForfeitWei: decimal(args[5]),
          totalRetainedWei: decimal(args[6]), refundWei: decimal(args[7]), maintenanceRequired: args[8] === true };
      case "LostSettled":
        if (decimal(tx.value) !== "0") throw new LibraryRpcError();
        return { ...common, eventName: "LostSettled", requestId, borrower, replacementPriceWei: decimal(args[2]),
          retainedWei: decimal(args[3]), refundWei: decimal(args[4]), shortfallWei: decimal(args[5]) };
      case "ShortfallPaid":
        if (decimal(tx.value) !== decimal(args[2])) throw new LibraryRpcError();
        return { ...common, eventName: "ShortfallPaid", requestId, borrower, amountWei: decimal(args[2]) };
      default:
        return null;
    }
  }
}
