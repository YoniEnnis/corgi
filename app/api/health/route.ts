import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export async function GET() {
  await db.execute(sql`select 1`);
  return Response.json({ status: "ok", database: "connected" });
}
