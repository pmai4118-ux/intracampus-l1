import express, { Router, type ErrorRequestHandler, type Request, type Response } from "express";
import { readSessionCookie } from "../auth/auth.routes.ts";
import { authClientAddress } from "../auth/client-address.ts";
import { AdminService, AdminServiceError } from "./admin.service.ts";

const errorMessages: Record<string, string> = {
  CONFIGURATION_ERROR: "Trang quản trị nội bộ chưa được cấu hình (thiếu ADMIN_ACCESS_KEY hoặc ADMIN_AUTH_ORIGIN).",
  INVALID_ACCESS_KEY: "Access key không chính xác.",
  UNAUTHENTICATED: "Phiên quản trị chưa đăng nhập hoặc đã hết hạn.",
  FORBIDDEN: "Origin không được phép cho thao tác quản trị.",
  RATE_LIMITED: "Thử sai key quá nhiều lần. Vui lòng chờ rồi thử lại.",
  VALIDATION_ERROR: "Dữ liệu gửi lên không hợp lệ.",
  INVALID_ADDRESS: "Địa chỉ ví không hợp lệ.",
  INVALID_AMOUNT: "Số tiền không hợp lệ (cần chuỗi số nguyên wei dương).",
  INVALID_HASH: "Mã giao dịch (txHash) không hợp lệ.",
  INVALID_EXPIRY: "Thời hạn thẻ SBT không hợp lệ.",
  EXPIRY_MUST_BE_FUTURE: "Thời hạn thẻ SBT phải nằm ở tương lai.",
  DEPLOYMENT_NOT_CONFIGURED: "Chưa có bản triển khai hợp đồng hợp lệ cho mạng hiện tại.",
  LIBRARY_NOT_CONFIGURED: "Chưa có bản triển khai hợp đồng Thư viện hợp lệ.",
  ESCROW_UPGRADE_REQUIRED: "Contract LibraryDepositEscrow đang deploy chưa hỗ trợ đổi ví động; hãy redeploy bản mới trên VM.",
  SIGNER_NOT_CONFIGURED: "Backend trên VM chưa cấu hình khóa signer cho quyền này.",
  SIGNER_ROLE_MISMATCH: "Khóa signer trong .env trên VM không khớp địa chỉ quyền trên hợp đồng.",
  SIGNER_INSUFFICIENT_FUNDS: "Ví signer trên VM không đủ CAMPUS để trả giá trị giao dịch và phí gas.",
  NATIVE_MINTER_ROLE_MISSING: "Ví funder chưa có quyền mint trên Native Minter. Ví Treasury cần ký setEnabled(funder) một lần trên chain 20261120.",
  NATIVE_MINTER_NOT_CONFIGURED: "Native Minter chưa được cấu hình cho mạng hiện tại.",
  ADMIN_BACKFILL_REQUIRED: "Hồ sơ đã duyệt trước đây cần được cấp quà bằng thao tác backfill trong bảng quản trị.",
  PAYOUT_IN_PROGRESS: "Lượt mint đang được xử lý. Hãy làm mới trạng thái, không tạo yêu cầu mới.",
  CLOUD_CHAIN_REQUIRED: "Native Minter chỉ được dùng trên chain cloud 20261120.",
  AMOUNT_LIMIT: "Số CAMPUS vượt giới hạn 100.000 CAMPUS mỗi lần cấp.",
  INVALID_REQUEST_ID: "Mã yêu cầu mint không hợp lệ. Hãy tải lại trang và thử lại.",
  IDEMPOTENCY_KEY_CONFLICT: "Mã yêu cầu mint đã được dùng cho ví hoặc số tiền khác.",
  MINT_IN_PROGRESS: "Yêu cầu mint này đang được xử lý. Hãy chờ và kiểm tra trạng thái, không tạo yêu cầu mới.",
  MINT_RECEIPT_MISMATCH: "Receipt Native Minter không khớp số tiền, ví nhận hoặc sự kiện mint mong đợi.",
  TX_SIMULATION_FAILED: "Mô phỏng giao dịch trên chain thất bại. Kiểm tra lại trạng thái hợp đồng và tham số.",
  TX_BROADCAST_FAILED: "Không gửi được giao dịch tới RPC nội bộ.",
  RPC_UNAVAILABLE: "Không kết nối được tới RPC nội bộ trên VM.",
  WRONG_CHAIN: "RPC đang trả sai Chain ID.",
  SBT_ALREADY_ISSUED: "Ví này đã có thẻ SBT. Chọn thu hồi thẻ cũ trước khi cấp mới.",
  SBT_REVOKE_PENDING: "Lệnh thu hồi thẻ SBT cũ đang chờ xác nhận trên chain. Vui lòng chờ vài giây rồi thử cấp mới lại.",
  SBT_NOT_FOUND: "Ví này hiện chưa có thẻ SBT để thu hồi.",
  INVALID_BENEFICIARY: "Ví nhận học bổng không hợp lệ (không được trùng địa chỉ Vault).",
  ACCOUNT_UPDATE_FAILED: "Không thể cập nhật trạng thái dịch vụ cho tài khoản này.",
  ALREADY_REVIEWED: "Hồ sơ này đã được duyệt trước đó.",
  PARKING_OPERATOR_ROLE_CONFLICT: "Ví này đã được gán vai trò khác (STUDENT/LIBRARIAN) trong hệ thống tài khoản.",
  LIBRARIAN_OPERATOR_ROLE_CONFLICT: "Ví này đã được gán vai trò khác (STUDENT/PARKING) trong hệ thống tài khoản.",
  INVALID_LIBRARY_TREASURY: "Ví Treasury không được trùng địa chỉ Escrow, Administrator hoặc Librarian hiện tại.",
  INVALID_LIBRARY_LIBRARIAN: "Ví Librarian không được trùng địa chỉ Escrow hoặc Treasury hiện tại.",
  INVALID_MERCHANT_ADDRESS: "Ví nhận không được trùng địa chỉ hợp đồng.",
  STUDENT_NOT_VERIFIED: "Cần duyệt hồ sơ sinh viên trước khi duyệt học bổng.",
  STUDENT_ID_ALREADY_VERIFIED: "Mã sinh viên này đã được xác minh cho một ví khác.",
};

function sendError(res: Response, error: unknown): void {
  res.set("Cache-Control", "no-store");
  if (error instanceof AdminServiceError) {
    if (error.retryAfterSeconds) res.set("Retry-After", String(Math.ceil(error.retryAfterSeconds)));
    res.status(error.httpStatus).json({
      error: {
        code: error.code,
        message: errorMessages[error.code] ?? error.code,
        retryable: error.code === "RATE_LIMITED" || error.code === "RPC_UNAVAILABLE",
      },
    });
    return;
  }
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Lỗi hệ thống khi xử lý yêu cầu quản trị.", retryable: false } });
}

function setAdminCookie(res: Response, name: string, token: string, maxAge: number, secure: boolean): void {
  const parts = [`${name}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAdminCookie(res: Response, name: string, secure: boolean): void {
  const parts = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function createAdminRouter(service?: AdminService) {
  const router = Router();
  const json = express.json({ limit: "16kb" });

  router.get("/api/config/runtime", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (!service) {
      res.status(503).json({ error: { code: "CONFIGURATION_ERROR" } });
      return;
    }
    try {
      res.json(await service.getPublicRuntimeConfig());
    } catch (error) {
      sendError(res, error);
    }
  });

  const requireConfigured = (_req: Request, res: Response, next: () => void) => {
    res.set("Cache-Control", "no-store");
    if (!service?.config) {
      sendError(res, new AdminServiceError("CONFIGURATION_ERROR", 503));
      return;
    }
    next();
  };

  const requireOrigin = (req: Request, res: Response, next: () => void) => {
    const config = service?.config;
    const origin = req.get("Origin");
    if (!config || !origin || !config.origins.includes(origin)) {
      sendError(res, new AdminServiceError("FORBIDDEN", 403));
      return;
    }
    next();
  };

  const requireSession = (req: Request, res: Response, next: () => void) => {
    const config = service?.config;
    if (!service || !config) {
      sendError(res, new AdminServiceError("CONFIGURATION_ERROR", 503));
      return;
    }
    const token = readSessionCookie(req, config.cookieName);
    const session = service.verifySession(token);
    if (!session) {
      sendError(res, new AdminServiceError("UNAUTHENTICATED", 401));
      return;
    }
    next();
  };

  router.get("/api/admin/auth/session", requireConfigured, (req, res) => {
    const config = service!.config!;
    const token = readSessionCookie(req, config.cookieName);
    const session = service!.verifySession(token);
    if (!session) {
      res.status(200).json({ authenticated: false, expiresAt: null });
      return;
    }
    res.json({ authenticated: true, expiresAt: session.expiresAt });
  });

  router.post("/api/admin/auth/login", requireConfigured, requireOrigin, json, (req, res) => {
    try {
      const config = service!.config!;
      const body = req.body as Record<string, unknown> | undefined;
      if (!req.is("application/json") || !body || typeof body !== "object" || Array.isArray(body)) {
        throw new AdminServiceError("VALIDATION_ERROR", 400);
      }
      const remoteAddress = authClientAddress(
        req.socket.remoteAddress ?? "",
        req.get("x-forwarded-for"),
        config.trustedProxyAddresses,
      );
      const { token, expiresAt } = service!.login({ key: body.key, remoteAddress });
      setAdminCookie(res, config.cookieName, token, config.sessionTtlSeconds, config.secureCookie);
      res.json({ authenticated: true, expiresAt });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/api/admin/auth/logout", requireConfigured, requireOrigin, (req, res) => {
    const config = service!.config!;
    const token = readSessionCookie(req, config.cookieName);
    service!.logout(token);
    clearAdminCookie(res, config.cookieName, config.secureCookie);
    res.json({ authenticated: false });
  });

  router.get("/api/admin/overview", requireConfigured, requireSession, async (_req, res) => {
    try { res.json(await service!.getOverview()); } catch (error) { sendError(res, error); }
  });

  router.get("/api/admin/tx/:txHash", requireConfigured, requireSession, async (req, res) => {
    try { res.json(await service!.getTransactionStatus(String(req.params.txHash))); } catch (error) { sendError(res, error); }
  });

  router.get("/api/admin/audit", requireConfigured, requireSession, (req, res) => {
    try {
      const rawLimit = req.query.limit ? Number(req.query.limit) : 50;
      const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
      res.json({ entries: service!.listAudit(limit) });
    } catch (error) { sendError(res, error); }
  });

  router.post("/api/admin/wallets/merchant", requireConfigured, requireOrigin, requireSession, json, async (req, res) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || (body.kind !== "PARKING" && body.kind !== "FOOD") || typeof body.address !== "string") {
        throw new AdminServiceError("VALIDATION_ERROR", 400);
      }
      const result = await service!.updateMerchantWallet({
        kind: body.kind,
        address: body.address,
        revokePrevious: body.revokePrevious === true,
      });
      res.status(result.txHashes.length > 0 ? 202 : 200).json(result);
    } catch (error) { sendError(res, error); }
  });

  router.post("/api/admin/wallets/registry-allowlist", requireConfigured, requireOrigin, requireSession, json, async (req, res) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body.merchant !== "string" || (body.category !== "PARKING" && body.category !== "FOOD") || typeof body.allowed !== "boolean") {
        throw new AdminServiceError("VALIDATION_ERROR", 400);
      }
      const result = await service!.setRegistryAllowlist({
        merchant: body.merchant,
        category: body.category,
        allowed: body.allowed,
      });
      res.status(202).json(result);
    } catch (error) { sendError(res, error); }
  });

  router.post("/api/admin/wallets/library-treasury", requireConfigured, requireOrigin, requireSession, json, async (req, res) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body.address !== "string") throw new AdminServiceError("VALIDATION_ERROR", 400);
      res.status(202).json(await service!.updateLibraryTreasury(body.address));
    } catch (error) { sendError(res, error); }
  });

  router.post("/api/admin/wallets/library-librarian", requireConfigured, requireOrigin, requireSession, json, async (req, res) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body.address !== "string") throw new AdminServiceError("VALIDATION_ERROR", 400);
      res.status(202).json(await service!.updateLibraryLibrarian(body.address));
    } catch (error) { sendError(res, error); }
  });

  router.put("/api/admin/campus-settings", requireConfigured, requireOrigin, requireSession, json, (req, res) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new AdminServiceError("VALIDATION_ERROR", 400);
      res.json(service!.updateCampusSettings({
        welcomeTreasury: body.welcomeTreasury === undefined ? undefined : (body.welcomeTreasury === null ? null : String(body.welcomeTreasury)),
        scholarshipWei: body.scholarshipWei === undefined ? undefined : (body.scholarshipWei === null ? null : String(body.scholarshipWei)),
      }));
    } catch (error) { sendError(res, error); }
  });

  router.get("/api/admin/students", requireConfigured, requireSession, async (_req, res) => {
    try { res.json({ students: await service!.listStudents() }); } catch (error) { sendError(res, error); }
  });

  router.get("/api/admin/students/:wallet", requireConfigured, requireSession, async (req, res) => {
    try { res.json({ student: await service!.inspectStudent(String(req.params.wallet)) }); } catch (error) { sendError(res, error); }
  });

  router.post("/api/admin/students/review", requireConfigured, requireOrigin, requireSession, json, async (req, res) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body.wallet !== "string" || typeof body.approve !== "boolean") {
        throw new AdminServiceError("VALIDATION_ERROR", 400);
      }
      res.json(await service!.reviewStudent({
        wallet: body.wallet,
        approve: body.approve,
        studentCode: typeof body.studentCode === "string" ? body.studentCode : undefined,
        program: typeof body.program === "string" ? body.program : undefined,
        reason: typeof body.reason === "string" ? body.reason : undefined,
        autoEnrollLibrary: typeof body.autoEnrollLibrary === "boolean" ? body.autoEnrollLibrary : true,
      }));
    } catch (error) { sendError(res, error); }
  });

  router.patch("/api/admin/students/:wallet/access", requireConfigured, requireOrigin, requireSession, json, async (req, res) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new AdminServiceError("VALIDATION_ERROR", 400);
      res.json(await service!.updateStudentAccess({
        wallet: String(req.params.wallet),
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        releaseHolds: body.releaseHolds === true,
      }));
    } catch (error) { sendError(res, error); }
  });

  router.post("/api/admin/students/:wallet/sbt/mint", requireConfigured, requireOrigin, requireSession, json, async (req, res) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body.expiresAt !== "number") throw new AdminServiceError("VALIDATION_ERROR", 400);
      res.status(202).json(await service!.mintSbt({
        wallet: String(req.params.wallet),
        expiresAt: body.expiresAt,
        replaceExisting: body.replaceExisting === true,
      }));
    } catch (error) { sendError(res, error); }
  });

  router.post("/api/admin/students/:wallet/sbt/revoke", requireConfigured, requireOrigin, requireSession, async (req, res) => {
    try {
      res.status(202).json(await service!.revokeSbt(String(req.params.wallet)));
    } catch (error) { sendError(res, error); }
  });

  router.post("/api/admin/students/:wallet/fund", requireConfigured, requireOrigin, requireSession, json, async (req, res) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body.amountWei !== "string" || (body.requestId !== undefined && typeof body.requestId !== "string")) {
        throw new AdminServiceError("VALIDATION_ERROR", 400);
      }
      res.status(202).json(await service!.fundTestCampus({
        wallet: String(req.params.wallet),
        amountWei: body.amountWei,
        requestId: typeof body.requestId === "string" ? body.requestId : undefined,
      }));
    } catch (error) { sendError(res, error); }
  });

  router.post("/api/admin/students/:wallet/welcome", requireConfigured, requireOrigin, requireSession, async (req, res) => {
    try { res.status(202).json(await service!.backfillWelcome(String(req.params.wallet))); }
    catch (error) { sendError(res, error); }
  });

  router.post("/api/admin/scholarships/review", requireConfigured, requireOrigin, requireSession, json, async (req, res) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body.wallet !== "string" || typeof body.approve !== "boolean") {
        throw new AdminServiceError("VALIDATION_ERROR", 400);
      }
      const category = body.category === "MERIT" || body.category === "SUPPORT" ? body.category : undefined;
      res.json(await service!.reviewScholarship({
        wallet: body.wallet,
        approve: body.approve,
        category,
        reason: typeof body.reason === "string" ? body.reason : undefined,
        autoApproveStudent: body.autoApproveStudent === true,
      }));
    } catch (error) { sendError(res, error); }
  });

  router.post("/api/admin/scholarships/grant", requireConfigured, requireOrigin, requireSession, json, async (req, res) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body.wallet !== "string" || typeof body.amountWei !== "string") {
        throw new AdminServiceError("VALIDATION_ERROR", 400);
      }
      res.status(202).json(await service!.issueFoodGrant({
        wallet: body.wallet,
        amountWei: body.amountWei,
        markScholarshipApproved: body.markScholarshipApproved !== false,
      }));
    } catch (error) { sendError(res, error); }
  });

  const jsonError: ErrorRequestHandler = (error, req, res, next) => {
    if (!req.path.startsWith("/api/admin")) return next(error);
    const status = error?.type === "entity.too.large" ? 413 : 400;
    sendError(res, new AdminServiceError("VALIDATION_ERROR", status));
  };
  router.use(jsonError);
  return router;
}
