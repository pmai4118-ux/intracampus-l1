import { campusNetwork, type NetworkProbe } from "@intracampus/network";

export async function GET(request: Request) {
  try {
    const backendUrl = process.env.BACKEND_URL?.trim() || "http://127.0.0.1:4000";
    const target = new URL("/api/network", backendUrl);
    target.search = new URL(request.url).search;
    const response = await fetch(target, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(3500),
    });

    return new Response(await response.text(), {
      status: response.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": response.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    const result: NetworkProbe = { status: "unreachable", expectedChainId: campusNetwork.chainId };
    return Response.json(result, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
