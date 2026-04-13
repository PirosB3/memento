import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(packageRoot, "../..");

const nextConfig: NextConfig = {
  serverExternalPackages: ["agentmail", "@temporalio/client"],
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
