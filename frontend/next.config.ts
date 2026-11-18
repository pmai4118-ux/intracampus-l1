import type { NextConfig } from "next";
import { basename, dirname, resolve } from "node:path";

const testDir = process.env.INTRACAMPUS_TEST_DIST_DIR;
if (testDir && dirname(resolve(testDir)) !== resolve(".next-tests")) {
  throw new Error("Test output must be a child directory of .next-tests");
}

const backendUrl = new URL(process.env.BACKEND_URL?.trim() || "http://127.0.0.1:4000");
if (!["http:", "https:"].includes(backendUrl.protocol) || backendUrl.username || backendUrl.password
  || backendUrl.search || backendUrl.hash || (backendUrl.protocol === "http:"
    && !["localhost", "127.0.0.1", "[::1]"].includes(backendUrl.hostname))) {
  throw new Error("BACKEND_URL must be HTTPS, or loopback HTTP for local development");
}

const nextConfig: NextConfig = {
  ...(testDir ? { distDir: `.next-tests/${basename(testDir)}/build`, typescript: { tsconfigPath: `.next-tests/${basename(testDir)}/tsconfig.json` } } : {}),
  turbopack: {
    root: resolve(".."),
  },
  transpilePackages: ["@intracampus/network"],
  async rewrites() {
    const backend = backendUrl.origin;
    return [
      { source: "/api/canteen/:path*", destination: `${backend}/api/canteen/:path*` },
      { source: "/api/invoices", destination: `${backend}/api/invoices` },
      { source: "/api/invoices/:path*", destination: `${backend}/api/invoices/:path*` },
      { source: "/api/grants/:path*", destination: `${backend}/api/grants/:path*` },
      { source: "/api/auth/:path*", destination: `${backend}/api/auth/:path*` },
      { source: "/api/library/:path*", destination: `${backend}/api/library/:path*` },
    ];
  },
};

export default nextConfig;
