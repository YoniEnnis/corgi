import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { cardHolds, ledgerEntries, outboundPayments } from "@/lib/db/schema";
import { requireRoles } from "@/lib/auth";

type RouteProps = { params: Promise<{ accountId: string }> };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: RouteProps) {
  const denied = await requireRoles(["owner"]);
  if (denied) return denied;

  const { accountId } = await params;
  if (!uuidPattern.test(accountId)) return Response.json({ error: "Invalid account ID." }, { status: 400 });

  const [entries, holds, payments] = await Promise.all([
    db.select().from(ledgerEntries).where(eq(ledgerEntries.accountId, accountId)).orderBy(desc(ledgerEntries.createdAt)).limit(100),
    db.select().from(cardHolds).where(eq(cardHolds.accountId, accountId)).orderBy(desc(cardHolds.createdAt)),
    db.select().from(outboundPayments).where(eq(outboundPayments.accountId, accountId)).orderBy(desc(outboundPayments.createdAt)),
  ]);

  const reversedSettlementIds = new Set(
    entries.filter((entry) => entry.type === "card_reversal" && entry.reversalOfId).map((entry) => entry.reversalOfId),
  );

  return Response.json({
    entries,
    stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")),
    cardHolds: holds.map((hold) => ({ ...hold, reversed: hold.settlementEntryId ? reversedSettlementIds.has(hold.settlementEntryId) : false })),
    payments,
  });
}
