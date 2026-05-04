import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(packageRoot, "../..");

// Hosts (in addition to localhost) that may load the dev server.
// Set DEV_ALLOWED_ORIGINS to a comma-separated list — e.g. via scripts/dev.sh
// when proxying through Tailscale — so HMR/asset loads aren't rejected.
const allowedDevOrigins = process.env.DEV_ALLOWED_ORIGINS
  ?.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  serverExternalPackages: ["agentmail", "@temporalio/client"],
  turbopack: {
    root: monorepoRoot,
  },
  ...(allowedDevOrigins?.length ? { allowedDevOrigins } : {}),
};

export default nextConfig;
