import type {
  AdminAuditEntry,
  AdminOverview,
  AdminStudentRecord,
  AdminTxStatus,
} from "@intracampus/network";

export class AdminApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AdminApiError";
    this.code = code;
    this.status = status;
  }
}

export function parseCampusToWei(input: string): string {
  const trimmed = input.trim().replaceAll(",", ".");
  if (!/^(0|[1-9][0-9]{0,59})(?:\.[0-9]{1,18})?$/.test(trimmed)) {
    throw new Error("Nhập số CAMPUS dương hợp lệ (tối đa 18 chữ số thập phân).");
  }
  const [whole, frac = ""] = trimmed.split(".");
  const wei = BigInt(whole) * (BigInt(10) ** BigInt(18)) + BigInt(frac.padEnd(18, "0"));
  const maxUint256 = (BigInt(2) ** BigInt(256)) - BigInt(1);
  if (wei <= BigInt(0) || wei > maxUint256) {
    throw new Error("Số CAMPUS phải lớn hơn 0.");
  }
  return wei.toString();
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const err = payload && typeof payload === "object" && "error" in payload
      ? (payload as { error?: { code?: string; message?: string } }).error
      : undefined;
    throw new AdminApiError(
      err?.code ?? "REQUEST_FAILED",
      err?.message ?? `Yêu cầu thất bại (HTTP ${response.status}).`,
      response.status,
    );
  }
  return payload as T;
}

export const adminApi = {
  session: () => request<{ authenticated: boolean; expiresAt: number | null }>("/api/admin/auth/session"),
  login: (key: string) =>
    request<{ authenticated: boolean; expiresAt: number }>("/api/admin/auth/login", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
  logout: () => request<{ authenticated: boolean }>("/api/admin/auth/logout", { method: "POST" }),
  overview: () => request<AdminOverview>("/api/admin/overview"),
  txStatus: (txHash: string) => request<AdminTxStatus>(`/api/admin/tx/${encodeURIComponent(txHash)}`),
  audit: (limit = 60) => request<{ entries: AdminAuditEntry[] }>(`/api/admin/audit?limit=${limit}`),
  updateMerchant: (input: { kind: "PARKING" | "FOOD"; address: string; revokePrevious: boolean }) =>
    request<{ address: string; txHashes: string[]; audit: AdminAuditEntry }>("/api/admin/wallets/merchant", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setRegistryAllowlist: (input: { merchant: string; category: "PARKING" | "FOOD"; allowed: boolean }) =>
    request<{ merchant: string; txHash: string; audit: AdminAuditEntry }>("/api/admin/wallets/registry-allowlist", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateLibraryTreasury: (address: string) =>
    request<{ address: string; txHash: string; audit: AdminAuditEntry }>("/api/admin/wallets/library-treasury", {
      method: "POST",
      body: JSON.stringify({ address }),
    }),
  updateLibraryLibrarian: (address: string) =>
    request<{ address: string; txHash: string; audit: AdminAuditEntry }>("/api/admin/wallets/library-librarian", {
      method: "POST",
      body: JSON.stringify({ address }),
    }),
  updateCampusSettings: (input: { welcomeTreasury?: string | null; scholarshipWei?: string | null }) =>
    request<{ welcomeTreasury: string | null; scholarshipWei: string; audit: AdminAuditEntry }>("/api/admin/campus-settings", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  listStudents: () => request<{ students: AdminStudentRecord[] }>("/api/admin/students"),
  inspectStudent: (wallet: string) =>
    request<{ student: AdminStudentRecord }>(`/api/admin/students/${encodeURIComponent(wallet)}`),
  reviewStudent: (input: {
    wallet: string;
    approve: boolean;
    studentCode?: string;
    program?: string;
    reason?: string;
    autoEnrollLibrary?: boolean;
  }) =>
    request<{ student: AdminStudentRecord; audit: AdminAuditEntry }>("/api/admin/students/review", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateStudentAccess: (wallet: string, input: { enabled?: boolean; releaseHolds?: boolean }) =>
    request<{ student: AdminStudentRecord; releasedHolds: number; audit: AdminAuditEntry }>(
      `/api/admin/students/${encodeURIComponent(wallet)}/access`,
      { method: "PATCH", body: JSON.stringify(input) },
    ),
  mintSbt: (wallet: string, input: { expiresAt: number; replaceExisting?: boolean }) =>
    request<{ wallet: string; txHashes: string[]; audit: AdminAuditEntry }>(
      `/api/admin/students/${encodeURIComponent(wallet)}/sbt/mint`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  revokeSbt: (wallet: string) =>
    request<{ wallet: string; tokenId: string; txHash: string; audit: AdminAuditEntry }>(
      `/api/admin/students/${encodeURIComponent(wallet)}/sbt/revoke`,
      { method: "POST" },
    ),
  fundCampus: (wallet: string, amountWei: string) =>
    request<{ wallet: string; amountWei: string; txHash: string; audit: AdminAuditEntry }>(
      `/api/admin/students/${encodeURIComponent(wallet)}/fund`,
      { method: "POST", body: JSON.stringify({ amountWei }) },
    ),
  reviewScholarship: (input: {
    wallet: string;
    approve: boolean;
    category?: "MERIT" | "SUPPORT";
    reason?: string;
    autoApproveStudent?: boolean;
  }) =>
    request<{ student: AdminStudentRecord; audit: AdminAuditEntry }>("/api/admin/scholarships/review", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  issueFoodGrant: (input: { wallet: string; amountWei: string; markScholarshipApproved?: boolean }) =>
    request<{ wallet: string; amountWei: string; txHash: string; audit: AdminAuditEntry }>("/api/admin/scholarships/grant", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
