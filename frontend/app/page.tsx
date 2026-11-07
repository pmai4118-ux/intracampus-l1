import { campusNetwork, type NetworkProbe } from "@intracampus/network";
import Link from "next/link";

export const dynamic = "force-dynamic";

const labels = {
  ready: "RPC trả về đúng chain ID",
  "not-configured": "Chưa cấu hình RPC",
  "wrong-chain": "RPC đang trỏ sai mạng",
  unreachable: "Không đọc được RPC",
} satisfies Record<NetworkProbe["status"], string>;

async function getNetworkStatus() {
  try {
    const backend = process.env.BACKEND_URL ?? "http://127.0.0.1:4000";
    const response = await fetch(new URL("/api/network", backend), {
      cache: "no-store",
      signal: AbortSignal.timeout(3500),
    });
    if (response.status !== 200 && response.status !== 503) return "Không đọc được trạng thái từ API";
    const data = await response.json() as NetworkProbe;
    if (data.status === "wrong-chain") return `${labels[data.status]} (${data.chainId})`;
    return labels[data.status] ?? "Không đọc được trạng thái từ API";
  } catch {
    return "Không kết nối được POS API";
  }
}

export default async function Home() {
  const status = await getNetworkStatus();
  return (
    <>
      <p className="eyebrow">Avalanche UniHack · Bản khởi tạo</p>
      <h1>Thanh toán trong khuôn viên trường</h1>
      <p>Khung ứng dụng cho ví sinh viên, điểm thu và thẻ sinh viên số trên IntraCampus L1.</p>
      <section className="card" aria-label="Trạng thái mạng">
        <h2>{campusNetwork.name}</h2>
        <p>Chain ID: {campusNetwork.chainId} · Gas: {campusNetwork.nativeCurrency.symbol}</p>
        <p>{status}</p>
      </section>
      <div className="links">
        <Link href="/student">Mở trang sinh viên</Link>
        <Link href="/pos">Mở trang điểm thu</Link>
      </div>
    </>
  );
}
