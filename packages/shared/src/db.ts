import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { getDatabaseUrl } from "./runtime";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
const connectionString = getDatabaseUrl();

function createClient() {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma || createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
