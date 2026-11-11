import { randomUUID } from "node:crypto";
import { Interface, Wallet, id } from "ethers";
import { campusNetwork, type SignedInvoiceEnvelope } from "@intracampus/network";
import { parkingService, type InvoiceCreationConfig } from "./invoice.config.ts";
import type { InvoiceRepository } from "./invoices.repository.ts";
import type { InvoiceRpc } from "./invoices.rpc.ts";
import { isAddress, object, quantity, safeQuantity, same } from "./invoices.schema.ts";
import type { InvoiceDeployment } from "./receipt.service.ts";

export const invoiceTypes = { Invoice: [
  { name: "invoiceId", type: "bytes32" }, { name: "merchant", type: "address" },
  { name: "category", type: "bytes32" }, { name: "amount", type: "uint256" },
  { name: "expiresAt", type: "uint64" },
] };
const signerAbi = new Interface(["function posSigner() view returns (address)"]);
type CreationErrorCode = "INVALID_REQUEST" | "UNKNOWN_SERVICE_OR_MERCHANT" | "INVALID_SIGNATURE"
  | "RPC_UNAVAILABLE" | "WRONG_CHAIN" | "INTERNAL_ERROR";
const errors: Record<CreationErrorCode, [number, string, string]> = {
  INVALID_REQUEST: [400, "Dữ liệu yêu cầu không hợp lệ hoặc bị thiếu.", "Kiểm tra lại thông tin dịch vụ và thử lại."],
  UNKNOWN_SERVICE_OR_MERCHANT: [400, "Điểm thu hoặc dịch vụ không nằm trong danh sách được phép.", "Chọn dịch vụ hợp lệ từ menu demo trên POS."],
  INVALID_SIGNATURE: [400, "Chữ ký hóa đơn không hợp lệ hoặc dữ liệu đã bị thay đổi.", "Không ký giao dịch; yêu cầu POS kiểm tra cấu hình signer và tạo hóa đơn mới."],
  RPC_UNAVAILABLE: [503, "Không kết nối được tới nút mạng IntraCampus L1 để xác minh dữ liệu.", "Giữ nguyên trạng thái hiện tại, kiểm tra kết nối RPC và thử đọc lại."],
  WRONG_CHAIN: [503, "Đang kết nối sai mạng (yêu cầu IntraCampus L1 — Chain ID 20261).", "Chuyển ví hoặc cấu hình RPC về mạng IntraCampus L1 (20261) rồi thử lại."],
  INTERNAL_ERROR: [500, "Không thể lưu hoặc đọc dữ liệu hóa đơn.", "Liên hệ người vận hành để kiểm tra kho hóa đơn."],
};
export class InvoiceCreationError extends Error {
  readonly code: CreationErrorCode;
  constructor(code: CreationErrorCode) { super(code); this.code = code; }
  get httpStatus() { return errors[this.code][0]; }
  get body() {
    const [, message, nextStep] = errors[this.code];
    return { error: { code: this.code, message, nextStep,
      retryable: this.code === "RPC_UNAVAILABLE" || this.code === "WRONG_CHAIN" } };
  }
}
export function validateInvoiceRequest(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvoiceCreationError("INVALID_REQUEST");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 2 || Object.keys(body).some((k) => k !== "merchantId" && k !== "serviceId")
    || typeof body.merchantId !== "string" || !body.merchantId || typeof body.serviceId !== "string" || !body.serviceId) {
    throw new InvoiceCreationError("INVALID_REQUEST");
  }
  if (body.merchantId !== parkingService.merchantId || body.serviceId !== parkingService.serviceId) {
    throw new InvoiceCreationError("UNKNOWN_SERVICE_OR_MERCHANT");
  }
}

export class InvoiceCreationService {
  private repository: InvoiceRepository;
  private rpc: InvoiceRpc;
  private deployment?: InvoiceDeployment;
  private config: InvoiceCreationConfig;
  constructor(options: { repository: InvoiceRepository; rpc: InvoiceRpc; deployment?: InvoiceDeployment; config: InvoiceCreationConfig }) {
    this.repository = options.repository; this.rpc = options.rpc;
    this.deployment = options.deployment; this.config = options.config;
  }

  async create(request: unknown) {
    validateInvoiceRequest(request);
    const { deployment, config } = this;
    if (!deployment || !isAddress(deployment.contractAddress) || !isAddress(config.merchant)) {
      throw new InvoiceCreationError("RPC_UNAVAILABLE");
    }
    let wallet: Wallet;
    try {
      if (!config.privateKey || !/^0x[0-9a-f]{64}$/i.test(config.privateKey)) throw new Error();
      wallet = new Wallet(config.privateKey);
    } catch { throw new InvoiceCreationError("INVALID_SIGNATURE"); }

    let issuedAt: number;
    try {
      if (quantity(await this.rpc.call("eth_chainId", [])) !== BigInt(campusNetwork.chainId)) {
        throw new InvoiceCreationError("WRONG_CHAIN");
      }
      const block = object(await this.rpc.call("eth_getBlockByNumber", ["latest", false]));
      safeQuantity(block.number);
      issuedAt = safeQuantity(block.timestamp);
      if (!Number.isSafeInteger(issuedAt + parkingService.ttlSeconds)
        || !Number.isFinite(new Date(issuedAt * 1000).getTime())) throw new Error();
      const rawSigner = await this.rpc.call("eth_call", [{ to: deployment.contractAddress,
        data: signerAbi.encodeFunctionData("posSigner") }, block.number]);
      if (typeof rawSigner !== "string" || !/^0x0{24}[0-9a-f]{40}$/i.test(rawSigner)) throw new Error();
      const signer = `0x${rawSigner.slice(-40)}`;
      if (!isAddress(signer) || !same(signer, wallet.address)) throw new InvoiceCreationError("INVALID_SIGNATURE");
    } catch (error) {
      if (error instanceof InvoiceCreationError) throw error;
      throw new InvoiceCreationError("RPC_UNAVAILABLE");
    }
    const invoiceCode = `INV-${new Date(issuedAt * 1000).toISOString().slice(0, 10).replaceAll("-", "")}-PARKING-${randomUUID()}`;
    const domain: SignedInvoiceEnvelope["domain"] = { name: "IntraCampusPayment", version: "1",
      chainId: campusNetwork.chainId, verifyingContract: deployment.contractAddress.toLowerCase() };
    const invoice = { invoiceId: id(invoiceCode), merchant: config.merchant.toLowerCase(), category: id(parkingService.categoryCode),
      amount: parkingService.amount.toString(), expiresAt: issuedAt + parkingService.ttlSeconds };
    const envelope: SignedInvoiceEnvelope = { schemaVersion: 1, domain, invoice,
      meta: { invoiceCode, merchantId: parkingService.merchantId, merchantName: parkingService.merchantName,
        serviceId: parkingService.serviceId, serviceName: parkingService.serviceName, categoryCode: parkingService.categoryCode, issuedAt },
      signer: wallet.address, signature: await wallet.signTypedData(domain, invoiceTypes, invoice) };
    try { this.repository.create(envelope); }
    catch { throw new InvoiceCreationError("INTERNAL_ERROR"); }
    const discount = parkingService.amount / 10n;
    return { invoiceId: invoice.invoiceId, status: "pending" as const, envelope, qrPayload: JSON.stringify(envelope),
      pricingPreview: {
        standard: { tier: 0, discountBps: 0, discountAmount: "0", paidAmount: invoice.amount },
        studentSbt: { tier: 1, discountBps: 1000, discountAmount: discount.toString(), paidAmount: (parkingService.amount - discount).toString() },
      }, transaction: null };
  }
}
