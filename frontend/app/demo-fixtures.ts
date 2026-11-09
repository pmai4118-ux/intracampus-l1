import { campusNetwork } from "@intracampus/network";

export type DemoUiState =
  | "loading"
  | "waiting"
  | "awaiting-signature"
  | "pending"
  | "error"
  | "receipt";
export type DemoWalletKind = "sbt" | "standard";
export type DemoErrorKind =
  | "expired"
  | "wrong-chain"
  | "rpc-unreachable"
  | "wallet-rejected"
  | "invalid-payload";

export interface InvoiceSignedEnvelopeFixture {
  schemaVersion: 1;
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  invoice: {
    invoiceId: string;
    merchant: string;
    category: string;
    /** Giá gốc theo đơn vị nhỏ nhất (wei) dạng chuỗi số nguyên */
    amount: string;
    /** Thời điểm hết hạn theo Unix giây */
    expiresAt: number;
  };
  meta: {
    invoiceCode: string;
    merchantId: string;
    merchantName: string;
    serviceId: string;
    serviceName: string;
    categoryCode: string;
    issuedAt: number;
    ttlSeconds: number;
  };
  signer: string;
  signature: string;
}

export interface DemoWalletProfile {
  kind: DemoWalletKind;
  label: string;
  studentName: string;
  studentIdLabel: string;
  address: string;
  balanceWei: string;
  sbt: {
    hasValidCard: boolean;
    tier: 0 | 1;
    badgeLabel: string;
    discountBps: number;
    expiresAtLabel: string;
    friendlyStatus: string;
  };
}

export interface DemoQuoteBreakdown {
  originalAmountWei: string;
  discountBps: number;
  discountAmountWei: string;
  paidAmountWei: string;
  estimatedGasWei: string;
}

export interface DemoReceiptFixture {
  invoiceId: string;
  invoiceCode: string;
  chainId: number;
  contractAddress: string;
  txHash: string;
  blockNumber: number;
  payer: string;
  payerName: string;
  merchant: string;
  originalAmountWei: string;
  discountAmountWei: string;
  paidAmountWei: string;
  gasUsed: string;
  gasFeeWei: string;
  tier: 0 | 1;
  verifiedAtLabel: string;
}

export interface DemoErrorScenario {
  kind: DemoErrorKind;
  code: string;
  shortTabLabel: string;
  studentTitle: string;
  posTitle: string;
  studentMessage: string;
  posMessage: string;
  nextStepStudent: string;
  nextStepPos: string;
  actionLabelStudent: string;
  actionLabelPos: string;
}

const WEI_PER_CAMPUS =
  BigInt(10) ** BigInt(campusNetwork.nativeCurrency.decimals);
const ZERO_BI = BigInt(0);
const BPS_DENOMINATOR = BigInt(10000);

/**
 * Định dạng chuỗi wei số nguyên sang dạng hiển thị thân thiện (ví dụ: "3000000000000000000000" -> "3.000 CAMPUS").
 * Tuân thủ AGENTS.md: chỉ dùng bigint cho tính toán và chỉ định dạng khi hiển thị.
 */
export function formatCampusWei(
  weiString: string,
  includeSymbol = true,
): string {
  const wei = BigInt(weiString);
  const whole = wei / WEI_PER_CAMPUS;
  const fraction = wei % WEI_PER_CAMPUS;

  const formattedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");

  let result = formattedWhole;
  if (fraction > ZERO_BI) {
    const fractionStr = fraction
      .toString()
      .padStart(campusNetwork.nativeCurrency.decimals, "0")
      .replace(/0+$/, "");
    if (fractionStr.length > 0) {
      result = `${formattedWhole},${fractionStr}`;
    }
  }

  return includeSymbol
    ? `${result} ${campusNetwork.nativeCurrency.symbol}`
    : result;
}

/**
 * Tính toán chi tiết số tiền phải trả từ giá gốc wei và mức giảm basis points bằng số học nguyên (bigint).
 */
export function calculateInvoiceQuote(
  originalAmountWei: string,
  discountBps: number,
  estimatedGasWei = "1710500000000000",
): DemoQuoteBreakdown {
  const original = BigInt(originalAmountWei);
  const discount = (original * BigInt(discountBps)) / BPS_DENOMINATOR;
  const paid = original - discount;

  return {
    originalAmountWei: original.toString(),
    discountBps,
    discountAmountWei: discount.toString(),
    paidAmountWei: paid.toString(),
    estimatedGasWei,
  };
}

export function shortenHex(hex: string, startChars = 8, endChars = 6): string {
  if (hex.length <= startChars + endChars + 2) return hex;
  return `${hex.slice(0, startChars)}…${hex.slice(-endChars)}`;
}

/**
 * Cùng một hóa đơn mẫu chuẩn dùng chung cho cả màn hình nhà xe (/pos) và Sinh viên (/student).
 * Khớp với bộ test vector EIP-712 của P02.
 */
export const sharedParkingInvoiceEnvelope: InvoiceSignedEnvelopeFixture = {
  schemaVersion: 1,
  domain: {
    name: "IntraCampusPayment",
    version: "1",
    chainId: campusNetwork.chainId,
    verifyingContract: "0x0000000000000000000000000000000000020261",
  },
  invoice: {
    invoiceId:
      "0x7dec24e2691f51c0bc1822acf25d4b07c5bd73ed5d641cc604f22eead02e69b1",
    merchant: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    category:
      "0xe3415db38bf7529604e320f58333c9ff6b278ff38b3391db9da4273c7be086eb",
    amount: "3000000000000000000000", // 3.000 CAMPUS
    expiresAt: 1794142800,
  },
  meta: {
    invoiceCode: "INV-20261108-PARKING-0001",
    merchantId: "parking-demo",
    merchantName: "Bãi xe demo",
    serviceId: "parking-single",
    serviceName: "Một lượt gửi xe demo",
    categoryCode: "PARKING",
    issuedAt: 1794142500,
    ttlSeconds: 300,
  },
  signer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  signature:
    "0x8a46fc98a37a6f12390c3bb91a6a02788e4e95542f99c1b3173de7070dbb222b5411461dc14d0f36c035742f31d6adb883efad686d9c85bd7c6a5a591b5b18581b",
};

export const sharedQrPayloadString = JSON.stringify(
  sharedParkingInvoiceEnvelope,
);

export const demoPosServices = [
  {
    serviceId: "parking-single",
    serviceName: "Một lượt gửi xe demo",
    subtitle: "Áp dụng giờ hành chính 06:00 – 18:00",
    categoryCode: "PARKING",
    amountWei: "3000000000000000000000",
    ttlSeconds: 300,
    active: true,
  },
  {
    serviceId: "parking-evening",
    serviceName: "Vé gửi xe máy ca tối",
    subtitle: "Áp dụng sau 18:00 (Mở ở bản đầy đủ)",
    categoryCode: "PARKING",
    amountWei: "5000000000000000000000",
    ttlSeconds: 300,
    active: false,
  },
] as const;

export const demoWalletProfiles: Record<DemoWalletKind, DemoWalletProfile> = {
  sbt: {
    kind: "sbt",
    label: "Sinh viên có thẻ trường (-10%)",
    studentName: "Sinh viên demo",
    studentIdLabel: "Hồ sơ demo",
    address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    balanceWei: "12500000000000000000000", // 12.500 CAMPUS
    sbt: {
      hasValidCard: true,
      tier: 1,
      badgeLabel: "Thẻ sinh viên hợp lệ · Giảm 10%",
      discountBps: 1000,
      expiresAtLabel: "30/06/2027",
      friendlyStatus: "Ưu đãi mẫu áp dụng cho dịch vụ gửi xe.",
    },
  },
  standard: {
    kind: "standard",
    label: "Khách thường / Thẻ hết hạn (0%)",
    studentName: "Khách gửi xe vãng lai",
    studentIdLabel: "Chưa liên kết thẻ sinh viên",
    address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    balanceWei: "10000000000000000000000", // 10.000 CAMPUS
    sbt: {
      hasValidCard: false,
      tier: 0,
      badgeLabel: "Không có ưu đãi sinh viên",
      discountBps: 0,
      expiresAtLabel: "Chưa kích hoạt",
      friendlyStatus:
        "Tài khoản chưa có thẻ sinh viên còn hạn nên tính đúng giá vé niêm yết.",
    },
  },
};

export const demoErrorScenarios: Record<DemoErrorKind, DemoErrorScenario> = {
  expired: {
    kind: "expired",
    code: "INVOICE_EXPIRED",
    shortTabLabel: "Hết hạn",
    studentTitle: "Hóa đơn đã hết hạn",
    posTitle: "Hóa đơn đã hết hạn",
    studentMessage:
      "Hóa đơn chỉ có hiệu lực trong 5 phút. Không tiếp tục thanh toán hóa đơn này.",
    posMessage:
      "Hóa đơn mẫu đã hết thời hạn thanh toán. Không dùng lại mã của lượt trước.",
    nextStepStudent:
      "Yêu cầu điểm thu tạo hóa đơn mới. Trong bản xem thử, bạn có thể tải lại phiếu mẫu.",
    nextStepPos:
      "Tạo hóa đơn mới ở bước tích hợp. Hiện tại chỉ có thể đặt lại phiếu mẫu.",
    actionLabelStudent: "Tải lại phiếu mẫu",
    actionLabelPos: "Đặt lại phiếu mẫu",
  },
  "wrong-chain": {
    kind: "wrong-chain",
    code: "WRONG_CHAIN",
    shortTabLabel: "Sai mạng",
    studentTitle: "Ví đang ở sai mạng",
    posTitle: "RPC đang trỏ sai mạng",
    studentMessage:
      "Mạng thanh toán yêu cầu là IntraCampus L1, chain ID 20261. Chưa thể yêu cầu ký.",
    posMessage:
      "Chain ID của RPC không khớp 20261. Tạm dừng tạo hóa đơn và xác nhận thanh toán.",
    nextStepStudent:
      "Chuyển ví sang IntraCampus L1 trước khi thanh toán. Nút dưới chỉ đặt lại tình huống mẫu.",
    nextStepPos:
      "Kiểm tra cấu hình RPC với người vận hành. Nút dưới chỉ đặt lại tình huống mẫu.",
    actionLabelStudent: "Quay lại phiếu mẫu",
    actionLabelPos: "Quay lại phiếu mẫu",
  },
  "rpc-unreachable": {
    kind: "rpc-unreachable",
    code: "RPC_UNAVAILABLE",
    shortTabLabel: "Lỗi RPC",
    studentTitle: "Chưa xác minh được thanh toán",
    posTitle: "Chưa đọc được kết quả thanh toán",
    studentMessage:
      "Không kết nối được RPC. Chưa đủ dữ liệu để kết luận giao dịch thành công hay thất bại.",
    posMessage:
      "Không đọc được receipt. Giữ trạng thái chờ, không xác nhận đã thu tiền.",
    nextStepStudent:
      "Kiểm tra kết nối và tra cứu lại giao dịch. Không gửi thêm giao dịch trong lúc chờ kết quả.",
    nextStepPos:
      "Kiểm tra kết nối rồi đọc lại trạng thái hóa đơn; không tạo giao dịch thanh toán thay sinh viên.",
    actionLabelStudent: "Thử lại tình huống mẫu",
    actionLabelPos: "Thử lại tình huống mẫu",
  },
  "wallet-rejected": {
    kind: "wallet-rejected",
    code: "USER_REJECTED",
    shortTabLabel: "Từ chối ký",
    studentTitle: "Bạn đã hủy yêu cầu ký",
    posTitle: "Sinh viên đã hủy yêu cầu ký",
    studentMessage:
      "Yêu cầu ký mẫu đã bị hủy. Không có giao dịch được gửi từ bản xem thử.",
    posMessage:
      "Hóa đơn chưa được thanh toán. Có thể xem lại hóa đơn trước khi thử ký lại.",
    nextStepStudent:
      "Kiểm tra số tiền, địa chỉ nhận và mạng trước khi thử lại.",
    nextStepPos: "Đề nghị sinh viên kiểm tra hóa đơn trước khi thử lại.",
    actionLabelStudent: "Xem lại hóa đơn",
    actionLabelPos: "Xem lại hóa đơn",
  },
  "invalid-payload": {
    kind: "invalid-payload",
    code: "INVALID_QR_PAYLOAD",
    shortTabLabel: "Mã không hợp lệ",
    studentTitle: "Nội dung không khớp phiếu mẫu",
    posTitle: "Nội dung hóa đơn không hợp lệ",
    studentMessage:
      "Bản xem thử chỉ nhận nguyên vẹn phiếu mẫu dùng chung với POS. Nội dung vừa nhập không được dùng để thanh toán.",
    posMessage: "Không sử dụng hóa đơn bị sửa hoặc thiếu dữ liệu.",
    nextStepStudent:
      "Dán lại phiếu mẫu từ POS hoặc bấm tải lại phiếu mẫu. Chưa kiểm tra chữ ký hay QR thật ở bước này.",
    nextStepPos: "Đặt lại phiếu mẫu để xem lại giao diện hóa đơn.",
    actionLabelStudent: "Tải lại phiếu mẫu",
    actionLabelPos: "Đặt lại phiếu mẫu",
  },
};

/** Chỉ nhận fixture đã biết; đây không phải bước xác minh EIP-712 của U03. */
export function matchesSharedDemoPayload(text: string): boolean {
  function matches(actual: unknown, expected: unknown): boolean {
    if (expected === null || typeof expected !== "object")
      return actual === expected;
    if (actual === null || typeof actual !== "object" || Array.isArray(actual))
      return false;
    const reference = expected as Record<string, unknown>;
    const candidate = actual as Record<string, unknown>;
    return (
      Object.keys(candidate).length === Object.keys(reference).length &&
      Object.keys(reference).every(
        (key) =>
          Object.hasOwn(candidate, key) &&
          matches(candidate[key], reference[key]),
      )
    );
  }
  try {
    return matches(JSON.parse(text), sharedParkingInvoiceEnvelope);
  } catch {
    return false;
  }
}

export function getDemoReceiptFixture(
  walletKind: DemoWalletKind,
): DemoReceiptFixture {
  const wallet = demoWalletProfiles[walletKind];
  const quote = calculateInvoiceQuote(
    sharedParkingInvoiceEnvelope.invoice.amount,
    wallet.sbt.discountBps,
  );

  return {
    invoiceId: sharedParkingInvoiceEnvelope.invoice.invoiceId,
    invoiceCode: sharedParkingInvoiceEnvelope.meta.invoiceCode,
    chainId: campusNetwork.chainId,
    contractAddress: sharedParkingInvoiceEnvelope.domain.verifyingContract,
    txHash:
      walletKind === "sbt"
        ? "0x9b5a6c7d8e9f00112233445566778899aabbccddeeff00112233445566778899"
        : "0x4e2d1a0b9c8f7766554433221100ffeeddccbbaa99887766554433221100aabb",
    blockNumber: walletKind === "sbt" ? 128 : 129,
    payer: wallet.address,
    payerName: wallet.studentName,
    merchant: sharedParkingInvoiceEnvelope.invoice.merchant,
    originalAmountWei: quote.originalAmountWei,
    discountAmountWei: quote.discountAmountWei,
    paidAmountWei: quote.paidAmountWei,
    gasUsed: "68420",
    gasFeeWei: quote.estimatedGasWei,
    tier: wallet.sbt.tier,
    verifiedAtLabel: "Biên lai giả lập · Chưa có xác nhận on-chain",
  };
}
