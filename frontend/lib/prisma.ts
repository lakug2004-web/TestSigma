import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

// Prisma 7 removed the bundled query engine, so the client runs through a
// driver adapter. The local Prisma Postgres dev server hands us a
// `prisma+postgres://` URL whose `api_key` embeds the real Postgres
// connection string — decode it so DATABASE_URL stays the single source of
// truth (and keeps working if the dev server restarts on new ports).
function resolveConnectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!url.startsWith("prisma+postgres://")) return url;

  const apiKey = new URL(url).searchParams.get("api_key");
  if (!apiKey) return url;
  const { databaseUrl } = JSON.parse(
    Buffer.from(apiKey, "base64").toString("utf-8"),
  );
  return databaseUrl as string;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: resolveConnectionString() }),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
