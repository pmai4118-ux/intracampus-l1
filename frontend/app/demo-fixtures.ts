import {
  CAMPUS_CHAIN_ID, campusNetwork,
  type CanteenDish,
  type CanteenOrder,
  type LibraryBook,
  type LibraryLoan,
  type LibraryRequest,
} from "@intracampus/network";

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
    amount: "3000000000000000000", // 3 CAMPUS
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
    "0x8f675e9c6e7fd9c0c3639ef0ef0a674fa778dd152cba42c8283720906203735d7edb628e28186eea478a28d1ee7b2ee79aa0f968a208f0bfa28b6646114917db1b",
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
    amountWei: "3000000000000000000", // 3 CAMPUS
    ttlSeconds: 300,
    active: true,
  },
  {
    serviceId: "parking-evening",
    serviceName: "Vé gửi xe máy ca tối",
    subtitle: "Áp dụng sau 18:00 (Mở ở bản đầy đủ)",
    categoryCode: "PARKING",
    amountWei: "5000000000000000000", // 5 CAMPUS
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
    balanceWei: "450000000000000000000", // 450 CAMPUS
    sbt: {
      hasValidCard: true,
      tier: 1,
      badgeLabel: "Thẻ sinh viên hợp lệ · Giảm 10%",
      discountBps: 1000,
      expiresAtLabel: "30/06/2027",
      friendlyStatus: "Ưu đãi mẫu áp dụng cho dịch vụ gửi xe và nhà ăn.",
    },
  },
  standard: {
    kind: "standard",
    label: "Khách thường / Thẻ hết hạn (0%)",
    studentName: "Khách gửi xe vãng lai",
    studentIdLabel: "Chưa liên kết thẻ sinh viên",
    address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    balanceWei: "120000000000000000000", // 120 CAMPUS
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
      `Mạng thanh toán yêu cầu là IntraCampus L1, chain ID ${CAMPUS_CHAIN_ID}. Chưa thể yêu cầu ký.`,
    posMessage:
      `Chain ID của RPC không khớp ${CAMPUS_CHAIN_ID}. Tạm dừng tạo hóa đơn và xác nhận thanh toán.`,
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

export type CanteenDishCategory = "main" | "snack-drink";

export interface DemoCanteenDishMeta extends CanteenDish {
  category: CanteenDishCategory;
  badge: string;
}

export const demoCanteenDishes: DemoCanteenDishMeta[] = [
  {
    id: "com-tam",
    name: "Cơm tấm",
    description: "Cơm tấm sườn nướng, đồ chua và rau.",
    priceWei: "18000000000000000000", // 18 CAMPUS
    active: true,
    category: "main",
    badge: "Bán chạy",
  },
  {
    id: "pho-bo",
    name: "Phở bò",
    description: "Phở bò với rau thơm.",
    priceWei: "22000000000000000000", // 22 CAMPUS
    active: true,
    category: "main",
    badge: "Truyền thống",
  },
  {
    id: "bun-bo",
    name: "Bún bò",
    description: "Bún bò và rau ăn kèm.",
    priceWei: "25000000000000000000", // 25 CAMPUS
    active: true,
    category: "main",
    badge: "Đậm vị",
  },
  {
    id: "com-ga-xoi-mo",
    name: "Cơm gà xối mỡ",
    description: "Đùi gà góc tư da giòn, cơm chiên hạt điều và canh rong biển.",
    priceWei: "22000000000000000000", // 22 CAMPUS
    active: true,
    category: "main",
    badge: "Món mới",
  },
  {
    id: "mi-quang-ga",
    name: "Mì Quảng gà trứng",
    description: "Mì Quảng gà ta, trứng cút, bánh đa nướng vừng và rau sống.",
    priceWei: "20000000000000000000", // 20 CAMPUS
    active: true,
    category: "main",
    badge: "Đặc sản",
  },
  {
    id: "banh-mi-cha-lua",
    name: "Bánh mì chả lụa đặc biệt",
    description: "Bánh mì giòn nóng, chả lụa, thịt nguội, pate gan và đồ chua.",
    priceWei: "12000000000000000000", // 12 CAMPUS
    active: true,
    category: "snack-drink",
    badge: "Bữa sáng",
  },
  {
    id: "tra-dao-cam-sa",
    name: "Trà đào cam sả",
    description: "Hồng trà ủ lạnh kết hợp đào miếng giòn, cam vàng và sả tươi.",
    priceWei: "8000000000000000000", // 8 CAMPUS
    active: true,
    category: "snack-drink",
    badge: "Giải nhiệt",
  },
  {
    id: "ca-phe-sua-da",
    name: "Cà phê sữa đá Sài Gòn",
    description: "Cà phê phin truyền thống đậm vị pha cùng sữa đặc.",
    priceWei: "6000000000000000000", // 6 CAMPUS
    active: true,
    category: "snack-drink",
    badge: "Tỉnh táo",
  },
  {
    id: "sua-chua-trai-cay",
    name: "Sữa chua trái cây hạt đác",
    description: "Sữa chua nhà làm mát lạnh, xoài chín, dâu tây và hạt đác rim dứa.",
    priceWei: "9000000000000000000", // 9 CAMPUS
    active: true,
    category: "snack-drink",
    badge: "Tráng miệng",
  },
];

export const demoCanteenOrders: CanteenOrder[] = [
  {
    id: "9f42c1a0-7b18-4d91-8a15-202611180001",
    wallet: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    method: "WALLET",
    items: [
      {
        dishId: "com-ga-xoi-mo",
        name: "Cơm gà xối mỡ",
        unitPriceWei: "22000000000000000000",
        quantity: 1,
      },
      {
        dishId: "tra-dao-cam-sa",
        name: "Trà đào cam sả",
        unitPriceWei: "8000000000000000000",
        quantity: 1,
      },
    ],
    totalWei: "30000000000000000000", // 30 CAMPUS
    status: "PAID",
    createdAt: 1794970800000,
    afterBlock: 32,
    invoiceId: "0x5a81c4e91f2049d3a8c7b1029384756102938475610293847561029384756101",
    txHash: "0x81c4e91f2049d3a8c7b1029384756102938475610293847561029384756101ab",
    paidAmountWei: "27000000000000000000", // 27 CAMPUS (-10% SBT)
  },
  {
    id: "4b19e8d2-3c04-4f22-9c81-202611180002",
    wallet: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    method: "FOOD",
    items: [
      {
        dishId: "pho-bo",
        name: "Phở bò",
        unitPriceWei: "22000000000000000000",
        quantity: 1,
      },
      {
        dishId: "ca-phe-sua-da",
        name: "Cà phê sữa đá Sài Gòn",
        unitPriceWei: "6000000000000000000",
        quantity: 1,
      },
    ],
    totalWei: "28000000000000000000", // 28 CAMPUS
    status: "PAID",
    createdAt: 1794963600000,
    afterBlock: 24,
    invoiceId: null,
    txHash: "0x62f1a803b9c412008877665544332211ffeeddccbbaa998877665544332211cd",
    paidAmountWei: "28000000000000000000", // 28 CAMPUS từ quỹ FOOD
  },
  {
    id: "d5f8987a-6a21-4e11-8c04-202611170003",
    wallet: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    method: "WALLET",
    items: [
      {
        dishId: "bun-bo",
        name: "Bún bò",
        unitPriceWei: "25000000000000000000",
        quantity: 1,
      },
    ],
    totalWei: "25000000000000000000", // 25 CAMPUS
    status: "PAID",
    createdAt: 1794884400000,
    afterBlock: 20,
    invoiceId: "0x1aa8633f5b399144ac44c9142bb9736eb0e6c1df4455a13809650450b100e737",
    txHash: "0x1aa8633f5b399144ac44c9142bb9736eb0e6c1df4455a13809650450b100e737",
    paidAmountWei: "22500000000000000000", // 22,5 CAMPUS (-10% SBT)
  },
  {
    id: "7c31b2f9-9e50-4a88-b102-202611160004",
    wallet: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    method: "WALLET",
    items: [
      {
        dishId: "mi-quang-ga",
        name: "Mì Quảng gà trứng",
        unitPriceWei: "20000000000000000000",
        quantity: 1,
      },
      {
        dishId: "sua-chua-trai-cay",
        name: "Sữa chua trái cây hạt đác",
        unitPriceWei: "9000000000000000000",
        quantity: 1,
      },
    ],
    totalWei: "29000000000000000000", // 29 CAMPUS
    status: "EXPIRED",
    createdAt: 1794798000000,
    afterBlock: 16,
    invoiceId: "0x3f21a904e8b71200998877665544332211ffeeddccbbaa9988776655443322ef",
    txHash: null,
    paidAmountWei: null,
  },
  {
    id: "2e84f019-1d33-4b72-9f44-202611150005",
    wallet: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    method: "FOOD",
    items: [
      {
        dishId: "com-tam",
        name: "Cơm tấm",
        unitPriceWei: "18000000000000000000",
        quantity: 1,
      },
      {
        dishId: "banh-mi-cha-lua",
        name: "Bánh mì chả lụa đặc biệt",
        unitPriceWei: "12000000000000000000",
        quantity: 1,
      },
    ],
    totalWei: "30000000000000000000", // 30 CAMPUS
    status: "PAID",
    createdAt: 1794711600000,
    afterBlock: 12,
    invoiceId: null,
    txHash: "0x44d8b123c9e011223344556677889900aabbccddeeff11223344556677889901",
    paidAmountWei: "30000000000000000000",
  },
  {
    id: "8a12c774-5f09-4d18-a290-202611140006",
    wallet: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    method: "WALLET",
    items: [
      {
        dishId: "com-tam",
        name: "Cơm tấm",
        unitPriceWei: "18000000000000000000",
        quantity: 1,
      },
    ],
    totalWei: "18000000000000000000", // 18 CAMPUS
    status: "PAID",
    createdAt: 1794625200000,
    afterBlock: 9,
    invoiceId: "0x77e9a012b4c56677889900112233445566778899aabbccddeeff001122334455",
    txHash: "0x55a0b123c4d5e6f708192a3b4c5d6e778091a2b3c4d5e6f708192a3b4c5d6e77",
    paidAmountWei: "16200000000000000000", // 16,2 CAMPUS (-10% SBT)
  },
];

export const demoLibraryBooks: LibraryBook[] = [
  {
    bookId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    title: "Kiến trúc Chuỗi khối & Mạng con Avalanche L1",
    author: "PGS.TS. Nguyễn Minh Khoa & Nhóm IntraCampus",
    isbn: "978-604-73-9102-4",
    depositWei: "50000000000000000000", // 50 CAMPUS
    replacementPriceWei: "30000000000000000000", // 30 CAMPUS
    copiesTotal: 4,
    copiesAvailable: 3,
  },
  {
    bookId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    title: "Mật mã học Ứng dụng & Chữ ký số EIP-712",
    author: "TS. Trần Hoàng Nam",
    isbn: "978-604-73-8841-3",
    depositWei: "50000000000000000000",
    replacementPriceWei: "80000000000000000000", // 80 CAMPUS (cao hơn cọc -> có shortfall nếu mất)
    copiesTotal: 3,
    copiesAvailable: 2,
  },
  {
    bookId: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    title: "Cấu trúc Dữ liệu & Giải thuật Nâng cao",
    author: "GS. Lê Văn Sơn · ĐHQG TP.HCM",
    isbn: "978-604-73-7412-6",
    depositWei: "50000000000000000000",
    replacementPriceWei: "45000000000000000000", // 45 CAMPUS
    copiesTotal: 5,
    copiesAvailable: 4,
  },
  {
    bookId: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    title: "Thiết kế Hệ thống Phân tán & Đồng thuận Mạng",
    author: "TS. Phạm Thanh Thảo",
    isbn: "978-604-73-9215-1",
    depositWei: "50000000000000000000",
    replacementPriceWei: "60000000000000000000", // 60 CAMPUS
    copiesTotal: 3,
    copiesAvailable: 1,
  },
  {
    bookId: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    title: "Lập trình Hợp đồng Thông minh với Solidity & Foundry",
    author: "ThS. Vũ Đức Anh",
    isbn: "978-604-73-9508-4",
    depositWei: "50000000000000000000",
    replacementPriceWei: "50000000000000000000", // 50 CAMPUS (bằng đúng tiền cọc)
    copiesTotal: 4,
    copiesAvailable: 3,
  },
  {
    bookId: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    title: "Trí tuệ Nhân tạo & Học sâu trong Khoa học Dữ liệu",
    author: "PGS.TS. Đặng Quốc Huy",
    isbn: "978-604-73-9630-2",
    depositWei: "50000000000000000000",
    replacementPriceWei: "75000000000000000000", // 75 CAMPUS
    copiesTotal: 2,
    copiesAvailable: 0, // Hết bản để demo trạng thái hết sách
  },
  {
    bookId: "0x1111111111111111111111111111111111111111111111111111111111111111",
    title: "An toàn Thông tin & Kiểm thử Bảo mật Web3",
    author: "TS. Ngô Quang Minh",
    isbn: "978-604-73-9711-8",
    depositWei: "50000000000000000000",
    replacementPriceWei: "65000000000000000000", // 65 CAMPUS
    copiesTotal: 3,
    copiesAvailable: 3,
  },
  {
    bookId: "0x2222222222222222222222222222222222222222222222222222222222222222",
    title: "Kinh tế học Token & Thiết kế Cơ chế Khuyến khích",
    author: "TS. Bùi Mai Phương",
    isbn: "978-604-73-9804-7",
    depositWei: "50000000000000000000",
    replacementPriceWei: "40000000000000000000", // 40 CAMPUS
    copiesTotal: 3,
    copiesAvailable: 2,
  },
];

const DEMO_ESCROW_ADDRESS = "0x43683f8107e3d3a883924989941620c5c260a124";
const DEMO_STUDENT_ADDRESS = "0x83907f9a2685efcbb2beda057cb23a3809c8f750";

export const demoLibraryRequests: LibraryRequest[] = [
  {
    requestId: "0x1010101010101010101010101010101010101010101010101010101010101001",
    bookId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    status: "PENDING_APPROVAL",
    refundStatus: "NONE",
    depositWei: "50000000000000000000",
    depositIntent: null,
    approvalDeadline: 1795056000,
    loanId: null,
    transactions: [
      {
        action: "deposit",
        txHash: "0x91a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f01",
        status: "CONFIRMED",
        submittedAt: 1794969600,
        proof: {
          chainId: CAMPUS_CHAIN_ID,
          contractAddress: DEMO_ESCROW_ADDRESS,
          txHash: "0x91a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f01",
          blockNumber: 34,
          blockHash: "0x71a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f11",
          logIndex: 0,
          eventName: "DepositReceived",
          requestId: "0x1010101010101010101010101010101010101010101010101010101010101001",
          borrower: DEMO_STUDENT_ADDRESS,
        },
      },
    ],
    createdAt: 1794969500,
    updatedAt: 1794969600,
  },
  {
    requestId: "0x2020202020202020202020202020202020202020202020202020202020202002",
    bookId: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    status: "EXPIRED_REFUND_DUE",
    refundStatus: "REFUND_DUE",
    depositWei: "50000000000000000000",
    depositIntent: null,
    approvalDeadline: 1794883200,
    loanId: null,
    transactions: [
      {
        action: "deposit",
        txHash: "0x82b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8002",
        status: "CONFIRMED",
        submittedAt: 1794796800,
        proof: {
          chainId: CAMPUS_CHAIN_ID,
          contractAddress: DEMO_ESCROW_ADDRESS,
          txHash: "0x82b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8002",
          blockNumber: 19,
          blockHash: "0x62b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8022",
          logIndex: 0,
          eventName: "DepositReceived",
          requestId: "0x2020202020202020202020202020202020202020202020202020202020202002",
          borrower: DEMO_STUDENT_ADDRESS,
        },
      },
    ],
    createdAt: 1794796700,
    updatedAt: 1794883201,
  },
];

export const demoLibraryLoans: LibraryLoan[] = [
  {
    loanId: "0x3030303030303030303030303030303030303030303030303030303030303003",
    requestId: "0x3030303030303030303030303030303030303030303030303030303030303003",
    bookId: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    borrower: DEMO_STUDENT_ADDRESS,
    status: "ACTIVE",
    approvedAt: 1794880000,
    dueAt: 1796089600,
    returnRequestedAt: null,
    returnReceivedAt: null,
    settlement: null,
  },
  {
    loanId: "0x4040404040404040404040404040404040404040404040404040404040404004",
    requestId: "0x4040404040404040404040404040404040404040404040404040404040404004",
    bookId: "0x2222222222222222222222222222222222222222222222222222222222222222",
    borrower: DEMO_STUDENT_ADDRESS,
    status: "RETURNED",
    approvedAt: 1793600000,
    dueAt: 1794809600,
    returnRequestedAt: 1794700000,
    returnReceivedAt: 1794703600,
    settlement: {
      outcome: "RETURNED",
      returnedAt: 1794703600,
      lateFeeWei: "0",
      repairFeeWei: "0",
      overdueForfeitWei: "0",
      totalRetainedWei: "0",
      refundWei: "50000000000000000000",
      maintenanceRequired: false,
    },
  },
  {
    loanId: "0x5050505050505050505050505050505050505050505050505050505050505005",
    requestId: "0x5050505050505050505050505050505050505050505050505050505050505005",
    bookId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    borrower: DEMO_STUDENT_ADDRESS,
    status: "LOST_SHORTFALL_DUE",
    approvedAt: 1793500000,
    dueAt: 1794709600,
    returnRequestedAt: null,
    returnReceivedAt: null,
    settlement: {
      outcome: "LOST",
      replacementPriceWei: "80000000000000000000",
      totalRetainedWei: "50000000000000000000",
      refundWei: "0",
      shortfallWei: "30000000000000000000",
    },
  },
];

const DEMO_STUDENT_B = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const DEMO_STUDENT_C = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";

export const demoStaffRequests: LibraryRequest[] = [
  ...demoLibraryRequests.filter((r) => r.status === "PENDING_APPROVAL"),
  {
    requestId: "0x1212121212121212121212121212121212121212121212121212121212121202",
    bookId: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    status: "PENDING_APPROVAL",
    refundStatus: "NONE",
    depositWei: "50000000000000000000",
    depositIntent: null,
    approvalDeadline: 1794993600,
    loanId: null,
    transactions: [
      {
        action: "deposit",
        txHash: "0x92a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f02",
        status: "CONFIRMED",
        submittedAt: 1794907200,
        proof: {
          chainId: CAMPUS_CHAIN_ID,
          contractAddress: DEMO_ESCROW_ADDRESS,
          txHash: "0x92a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f02",
          blockNumber: 35,
          blockHash: "0x72a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f12",
          logIndex: 0,
          eventName: "DepositReceived",
          requestId: "0x1212121212121212121212121212121212121212121212121212121212121202",
          borrower: DEMO_STUDENT_B,
        },
      },
    ],
    createdAt: 1794907100,
    updatedAt: 1794907200,
  },
  {
    requestId: "0x1313131313131313131313131313131313131313131313131313131313131303",
    bookId: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    status: "REJECTED_NO_COPY",
    refundStatus: "REFUND_DUE",
    depositWei: "50000000000000000000",
    depositIntent: null,
    approvalDeadline: 1795040000,
    loanId: null,
    transactions: [
      {
        action: "deposit",
        txHash: "0x93a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f03",
        status: "CONFIRMED",
        submittedAt: 1794953600,
        proof: {
          chainId: CAMPUS_CHAIN_ID,
          contractAddress: DEMO_ESCROW_ADDRESS,
          txHash: "0x93a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f03",
          blockNumber: 36,
          blockHash: "0x73a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f13",
          logIndex: 0,
          eventName: "DepositReceived",
          requestId: "0x1313131313131313131313131313131313131313131313131313131313131303",
          borrower: DEMO_STUDENT_C,
        },
      },
    ],
    createdAt: 1794953500,
    updatedAt: 1794953600,
  },
];

export const demoStaffLoans: LibraryLoan[] = [
  {
    loanId: "0x6060606060606060606060606060606060606060606060606060606060606006",
    requestId: "0x6060606060606060606060606060606060606060606060606060606060606006",
    bookId: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    borrower: DEMO_STUDENT_B,
    status: "SETTLEMENT_PENDING",
    approvedAt: 1793800000,
    dueAt: 1795009600,
    returnRequestedAt: 1794965000,
    returnReceivedAt: 1794968400,
    settlement: null,
  },
  {
    loanId: "0x7070707070707070707070707070707070707070707070707070707070707007",
    requestId: "0x7070707070707070707070707070707070707070707070707070707070707007",
    bookId: "0x1111111111111111111111111111111111111111111111111111111111111111",
    borrower: DEMO_STUDENT_C,
    status: "RETURN_REQUESTED",
    approvedAt: 1793900000,
    dueAt: 1795109600,
    returnRequestedAt: 1794970000,
    returnReceivedAt: null,
    settlement: null,
  },
  ...demoLibraryLoans,
  {
    loanId: "0x8080808080808080808080808080808080808080808080808080808080808008",
    requestId: "0x8080808080808080808080808080808080808080808080808080808080808008",
    bookId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    borrower: DEMO_STUDENT_B,
    status: "RETURNED",
    approvedAt: 1793100000,
    dueAt: 1794309600,
    returnRequestedAt: 1794280000,
    returnReceivedAt: 1794283600,
    settlement: {
      outcome: "RETURNED",
      returnedAt: 1794283600,
      lateFeeWei: "0",
      repairFeeWei: "10000000000000000000", // 10 CAMPUS sửa gáy sách
      overdueForfeitWei: "0",
      totalRetainedWei: "10000000000000000000",
      refundWei: "40000000000000000000", // 40 CAMPUS hoàn
      maintenanceRequired: true,
    },
  },
  {
    loanId: "0x9090909090909090909090909090909090909090909090909090909090909009",
    requestId: "0x9090909090909090909090909090909090909090909090909090909090909009",
    bookId: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    borrower: DEMO_STUDENT_C,
    status: "RETURNED",
    approvedAt: 1791200000,
    dueAt: 1792409600,
    returnRequestedAt: 1795000000,
    returnReceivedAt: 1795001600,
    settlement: {
      outcome: "RETURNED",
      returnedAt: 1795001600,
      lateFeeWei: "2700000000000000000", // 2,7 CAMPUS phí trễ
      repairFeeWei: "0",
      overdueForfeitWei: "0",
      totalRetainedWei: "2700000000000000000",
      refundWei: "47300000000000000000", // 47,3 CAMPUS hoàn
      maintenanceRequired: false,
    },
  },
  {
    loanId: "0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a010",
    requestId: "0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a010",
    bookId: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    borrower: DEMO_STUDENT_ADDRESS,
    status: "RETURNED",
    approvedAt: 1792500000,
    dueAt: 1793709600,
    returnRequestedAt: 1793600000,
    returnReceivedAt: 1793605000,
    settlement: {
      outcome: "RETURNED",
      returnedAt: 1793605000,
      lateFeeWei: "0",
      repairFeeWei: "0",
      overdueForfeitWei: "0",
      totalRetainedWei: "0",
      refundWei: "50000000000000000000",
      maintenanceRequired: false,
    },
  },
  {
    loanId: "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b011",
    requestId: "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b011",
    bookId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    borrower: DEMO_STUDENT_C,
    status: "LOST_SETTLED",
    approvedAt: 1792000000,
    dueAt: 1793209600,
    returnRequestedAt: null,
    returnReceivedAt: null,
    settlement: {
      outcome: "LOST",
      replacementPriceWei: "30000000000000000000", // 30 CAMPUS < 50 cọc -> hoàn 20
      totalRetainedWei: "30000000000000000000",
      refundWei: "20000000000000000000",
      shortfallWei: "0",
    },
  },
  {
    loanId: "0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c012",
    requestId: "0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c012",
    bookId: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    borrower: DEMO_STUDENT_B,
    status: "RETURNED",
    approvedAt: 1791800000,
    dueAt: 1793009600,
    returnRequestedAt: 1792900000,
    returnReceivedAt: 1792904000,
    settlement: {
      outcome: "RETURNED",
      returnedAt: 1792904000,
      lateFeeWei: "0",
      repairFeeWei: "0",
      overdueForfeitWei: "0",
      totalRetainedWei: "0",
      refundWei: "50000000000000000000",
      maintenanceRequired: false,
    },
  },
];

export const demoStudentLibraryLoans: LibraryLoan[] = [
  ...demoLibraryLoans,
  ...demoStaffLoans
    .filter((l) => ["RETURNED", "LOST_SETTLED"].includes(l.status) && l.loanId !== "0x4040404040404040404040404040404040404040404040404040404040404004")
    .slice(0, 4)
    .map((l) => ({ ...l, borrower: DEMO_STUDENT_ADDRESS as `0x${string}` })),
];

export interface PosSessionLedgerEntry {
  invoiceId: string;
  invoiceCode: string;
  serviceName: string;
  amountWei: string;
  paidAmountWei: string | null;
  status: "pending" | "paid" | "expired" | "rpc-error";
  tier: number | null;
  txHash: string | null;
  createdAt: number;
}

export const demoPosSessionHistory: PosSessionLedgerEntry[] = [
  {
    invoiceId: sharedParkingInvoiceEnvelope.invoice.invoiceId,
    invoiceCode: sharedParkingInvoiceEnvelope.meta.invoiceCode,
    serviceName: sharedParkingInvoiceEnvelope.meta.serviceName,
    amountWei: "3000000000000000000",
    paidAmountWei: null,
    status: "pending",
    tier: null,
    txHash: null,
    createdAt: 1794975600000,
  },
  {
    invoiceId: "0x71a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f01",
    invoiceCode: "PK-2026-041",
    serviceName: "Vé giữ xe máy một lượt",
    amountWei: "3000000000000000000",
    paidAmountWei: "2700000000000000000",
    status: "paid",
    tier: 1,
    txHash: "0x9b5a6c7d8e9f00112233445566778899aabbccddeeff00112233445566778899",
    createdAt: 1794975100000,
  },
  {
    invoiceId: "0x72a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f02",
    invoiceCode: "PK-2026-040",
    serviceName: "Vé giữ xe máy một lượt",
    amountWei: "3000000000000000000",
    paidAmountWei: "3000000000000000000",
    status: "paid",
    tier: 0,
    txHash: "0x4e2d1a0b9c8f7766554433221100ffeeddccbbaa99887766554433221100aabb",
    createdAt: 1794974400000,
  },
  {
    invoiceId: "0x73a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f03",
    invoiceCode: "PK-2026-039",
    serviceName: "Vé giữ xe máy một lượt",
    amountWei: "3000000000000000000",
    paidAmountWei: null,
    status: "expired",
    tier: null,
    txHash: null,
    createdAt: 1794973500000,
  },
  {
    invoiceId: "0x74a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f04",
    invoiceCode: "PK-2026-038",
    serviceName: "Vé giữ xe máy một lượt",
    amountWei: "3000000000000000000",
    paidAmountWei: "2700000000000000000",
    status: "paid",
    tier: 1,
    txHash: "0x61c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c",
    createdAt: 1794972900000,
  },
  {
    invoiceId: "0x75a2b3c4d5e6f708192a3b4c5d6e7f08192a3b4c5d6e7f8091a2b3c4d5e6f705",
    invoiceCode: "PK-2026-037",
    serviceName: "Vé giữ xe máy một lượt",
    amountWei: "3000000000000000000",
    paidAmountWei: "2700000000000000000",
    status: "paid",
    tier: 1,
    txHash: "0x82d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d",
    createdAt: 1794972200000,
  },
];

export type CanteenStaffOrder = Omit<CanteenOrder, "wallet"> & {
  payerHint: string;
  servedAt: number | null;
};

export const DEMO_CANTEEN_MERCHANT_WALLET = "0x24c9970D5a3a1A2107adA59Da4dbA276Fc33C83b";

export const demoCanteenStaffOrders: CanteenStaffOrder[] = [
  {
    id: "9f42c1a0-7b18-4d91-8a15-202611180001",
    payerHint: "0x3c44…93bc",
    method: "WALLET",
    items: [
      { dishId: "com-ga-xoi-mo", name: "Cơm gà xối mỡ", unitPriceWei: "22000000000000000000", quantity: 1 },
      { dishId: "tra-dao-cam-sa", name: "Trà đào cam sả", unitPriceWei: "8000000000000000000", quantity: 1 },
    ],
    totalWei: "30000000000000000000",
    status: "PAID",
    createdAt: 1794975420000,
    afterBlock: 36,
    invoiceId: "0x5a81c4e91f2049d3a8c7b1029384756102938475610293847561029384756101",
    txHash: "0x81c4e91f2049d3a8c7b1029384756102938475610293847561029384756101ab",
    paidAmountWei: "27000000000000000000",
    servedAt: null,
  },
  {
    id: "4b19e8d2-3c04-4f22-9c81-202611180002",
    payerHint: "0x8390…f750",
    method: "FOOD",
    items: [
      { dishId: "pho-bo", name: "Phở bò", unitPriceWei: "22000000000000000000", quantity: 1 },
      { dishId: "ca-phe-sua-da", name: "Cà phê sữa đá Sài Gòn", unitPriceWei: "6000000000000000000", quantity: 1 },
    ],
    totalWei: "28000000000000000000",
    status: "PAID",
    createdAt: 1794975540000,
    afterBlock: 37,
    invoiceId: null,
    txHash: "0x62f1a803b9c412008877665544332211ffeeddccbbaa998877665544332211cd",
    paidAmountWei: "28000000000000000000",
    servedAt: null,
  },
  {
    id: "a820f319-1c12-4a09-8d77-202611180003",
    payerHint: "0x90f7…b906",
    method: "WALLET",
    items: [
      { dishId: "com-tam", name: "Cơm tấm", unitPriceWei: "18000000000000000000", quantity: 2 },
      { dishId: "sua-chua-trai-cay", name: "Sữa chua trái cây hạt đác", unitPriceWei: "9000000000000000000", quantity: 2 },
    ],
    totalWei: "54000000000000000000",
    status: "PAID",
    createdAt: 1794975660000,
    afterBlock: 38,
    invoiceId: "0x11c4e91f2049d3a8c7b1029384756102938475610293847561029384756101cd",
    txHash: "0x33c4e91f2049d3a8c7b1029384756102938475610293847561029384756101ef",
    paidAmountWei: "48600000000000000000",
    servedAt: null,
  },
  {
    id: "e190b77c-4f10-4b21-9a11-202611180004",
    payerHint: "0x7099…79c8",
    method: "WALLET",
    items: [
      { dishId: "bun-bo", name: "Bún bò", unitPriceWei: "25000000000000000000", quantity: 1 },
    ],
    totalWei: "25000000000000000000",
    status: "AWAITING_PAYMENT",
    createdAt: 1794975720000,
    afterBlock: 38,
    invoiceId: "0x44c4e91f2049d3a8c7b102938475610293847561029384756102938475610199",
    txHash: null,
    paidAmountWei: null,
    servedAt: null,
  },
  {
    id: "d5f8987a-6a21-4e11-8c04-202611180005",
    payerHint: "0x3c44…93bc",
    method: "WALLET",
    items: [
      { dishId: "bun-bo", name: "Bún bò", unitPriceWei: "25000000000000000000", quantity: 1 },
    ],
    totalWei: "25000000000000000000",
    status: "PAID",
    createdAt: 1794974400000,
    afterBlock: 30,
    invoiceId: "0x1aa8633f5b399144ac44c9142bb9736eb0e6c1df4455a13809650450b100e737",
    txHash: "0x1aa8633f5b399144ac44c9142bb9736eb0e6c1df4455a13809650450b100e737",
    paidAmountWei: "22500000000000000000",
    servedAt: 1794974640000,
  },
  {
    id: "2e84f019-1d33-4b72-9f44-202611180006",
    payerHint: "0x15d3…6a65",
    method: "FOOD",
    items: [
      { dishId: "com-tam", name: "Cơm tấm", unitPriceWei: "18000000000000000000", quantity: 1 },
      { dishId: "banh-mi-cha-lua", name: "Bánh mì chả lụa đặc biệt", unitPriceWei: "12000000000000000000", quantity: 1 },
    ],
    totalWei: "30000000000000000000",
    status: "PAID",
    createdAt: 1794973800000,
    afterBlock: 28,
    invoiceId: null,
    txHash: "0x44d8b123c9e011223344556677889900aabbccddeeff11223344556677889901",
    paidAmountWei: "30000000000000000000",
    servedAt: 1794974010000,
  },
  {
    id: "6c10a552-8e09-4c18-a290-202611180007",
    payerHint: "0x9965…a4dc",
    method: "WALLET",
    items: [
      { dishId: "mi-quang-ga", name: "Mì Quảng gà trứng", unitPriceWei: "20000000000000000000", quantity: 1 },
      { dishId: "tra-dao-cam-sa", name: "Trà đào cam sả", unitPriceWei: "8000000000000000000", quantity: 1 },
    ],
    totalWei: "28000000000000000000",
    status: "PAID",
    createdAt: 1794973100000,
    afterBlock: 25,
    invoiceId: "0x77e9a012b4c56677889900112233445566778899aabbccddeeff001122334455",
    txHash: "0x55a0b123c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e77",
    paidAmountWei: "25200000000000000000",
    servedAt: 1794973350000,
  },
  {
    id: "7c31b2f9-9e50-4a88-b102-202611180008",
    payerHint: "0x976e…0aa9",
    method: "WALLET",
    items: [
      { dishId: "ca-phe-sua-da", name: "Cà phê sữa đá Sài Gòn", unitPriceWei: "6000000000000000000", quantity: 2 },
    ],
    totalWei: "12000000000000000000",
    status: "EXPIRED",
    createdAt: 1794972400000,
    afterBlock: 22,
    invoiceId: "0x3f21a904e8b71200998877665544332211ffeeddccbbaa9988776655443322ef",
    txHash: null,
    paidAmountWei: null,
    servedAt: null,
  },
];
