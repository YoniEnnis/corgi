import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { businessAccounts, cardHolds, ledgerEntries, outboundPayments } from "@/lib/db/schema";

type RouteProps = { params: Promise<{ accountId: string }> };

async function total(query: PromiseLike<Array<{ amount: number }>>) {
  const [row] = await query;
  return row?.amount ?? 0;
}

export async function GET(_request: Request, { params }: RouteProps) {
  const { accountId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountId)) {
    return Response.json({ error: "Invalid account ID." }, { status: 400 });
  }

  const [account] = await db
    .select({ id: businessAccounts.id, name: businessAccounts.name, currency: businessAccounts.currency })
    .from(businessAccounts)
    .where(and(eq(businessAccounts.id, accountId), eq(businessAccounts.active, true)))
    .limit(1);

  if (!account) return Response.json({ error: "Account not found." }, { status: 404 });

  const asOf = new Date();
  const [recordedBalanceCents, availableLedgerCents, openHoldsCents, pendingPaymentsCents] = await Promise.all([
    total(db.select({ amount: sql<number>`coalesce(sum(${ledgerEntries.amountCents}), 0)::bigint`.mapWith(Number) }).from(ledgerEntries).where(eq(ledgerEntries.accountId, accountId))),
    total(db.select({ amount: sql<number>`coalesce(sum(${ledgerEntries.amountCents}), 0)::bigint`.mapWith(Number) }).from(ledgerEntries).where(and(eq(ledgerEntries.accountId, accountId), lte(ledgerEntries.availableAt, asOf)))),
    total(db.select({ amount: sql<number>`coalesce(sum(${cardHolds.amountCents}), 0)::bigint`.mapWith(Number) }).from(cardHolds).where(and(eq(cardHolds.accountId, accountId), eq(cardHolds.status, "open")))),
    total(db.select({ amount: sql<number>`coalesce(sum(${outboundPayments.amountCents}), 0)::bigint`.mapWith(Number) }).from(outboundPayments).where(and(eq(outboundPayments.accountId, accountId), eq(outboundPayments.status, "pending")))),
  ]);

  return Response.json({
    account,
    asOf: asOf.toISOString(),
    balances: {
      recordedBalanceCents,
      availableBalanceCents: availableLedgerCents - openHoldsCents - pendingPaymentsCents,
      pendingIncomingCents: recordedBalanceCents - availableLedgerCents,
      cardHoldsCents: openHoldsCents,
      pendingPaymentsCents,
    },
  });
}
