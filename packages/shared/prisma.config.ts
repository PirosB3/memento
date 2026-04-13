import { defineConfig } from "prisma/config";

const DEFAULT_DATABASE_URL = "postgresql://summon:summon@localhost:5432/summon_dev";

export default defineConfig({
  schema: "./prisma/schema.prisma",
  migrations: {
    path: "./prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  },
});
