import "server-only";

import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is missing. Run `neon env pull` to configure Neon.");
}

const globalForDb = globalThis as typeof globalThis & {
  neonPool?: Pool;
};

const pool = globalForDb.neonPool ?? new Pool({ connectionString, max: 1 });
if (process.env.NODE_ENV !== "production") globalForDb.neonPool = pool;

export const db = drizzle(pool, { schema });
