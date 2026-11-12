import type { NextConfig } from "next";

const backendUrl = new URL(process.env.BACKEND_URL?.trim() || "http://127.0.0.1:4000");
if (!["http:", "https:"].includes(backendUrl.protocol) || backendUrl.username || backendUrl.password
  || backendUrl.search || backendUrl.hash || (backendUrl.protocol === "http:"
    && !["localhost", "127.0.0.1", "[::1]"].includes(backendUrl.hostname))) {
  throw new Error("BACKEND_URL must be HTTPS, or loopback HTTP for local development");
}

const nextConfig: NextConfig = {
  transpilePackages: ["@intracampus/network"],
  async rewrites() {
    const backend = backendUrl.origin;
    return [
      { source: "/api/invoices", destination: `${backend}/api/invoices` },
      { source: "/api/invoices/:path*", destination: `${backend}/api/invoices/:path*` },
    ];
  },
};

export default nextConfig;
