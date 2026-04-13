import { defineConfig, defineProject } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

const sharedProjectConfig = {
  environment: "node" as const,
  globals: true,
  clearMocks: true,
  restoreMocks: true,
  mockReset: true,
};

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    projects: [
      defineProject({
        test: {
          ...sharedProjectConfig,
          name: "unit",
          include: ["packages/**/*.unit.test.ts"],
        },
      }),
      defineProject({
        test: {
          ...sharedProjectConfig,
          name: "integration",
          include: ["packages/**/*.integration.test.ts"],
        },
      }),
      defineProject({
        test: {
          ...sharedProjectConfig,
          name: "workflow",
          include: ["packages/**/*.workflow.test.ts"],
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      }),
    ],
  },
});
