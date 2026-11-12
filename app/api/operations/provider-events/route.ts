import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businessAccounts, cardHolds, processedEvents } from "@/lib/db/schema";
import { requireRoles } from "@/lib/auth";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const denied = await requireRoles(["operations"]);
  if (denied) return denied;
  const accountId = new URL(request.url).searchParams.get("accountId");
  if (!accountId || !uuidPattern.test(accountId)) return Response.json({ error: "Provide a valid accountId query parameter." }, { status: 400 });

  const [account] = await db.select({ id: businessAccounts.id }).from(businessAccounts)
    .where(and(eq(businessAccounts.id, accountId), eq(businessAccounts.active, true))).limit(1);
  if (!account) return Response.json({ error: "Account not found." }, { status: 404 });

  const [holds, stripeEvents, plaidEvents] = await Promise.all([
    db.select({ externalAuthId: cardHolds.externalAuthId }).from(cardHolds).where(eq(cardHolds.accountId, accountId)),
    db.select().from(processedEvents).where(eq(processedEvents.provider, "stripe"))
      .orderBy(desc(processedEvents.firstReceivedAt)).limit(200),
    db.select().from(processedEvents).where(eq(processedEvents.provider, "plaid-transfer"))
      .orderBy(desc(processedEvents.firstReceivedAt)).limit(200),
  ]);
  const paymentIntentIds = new Set(holds.map((hold) => hold.externalAuthId).filter((id) => id.startsWith("pi_")));
  const stripeRows = stripeEvents.flatMap((row) => {
    const event = row.payload as { data?: { object?: Record<string, unknown> } };
    const object = event.data?.object;
    if (!object) return [];
    const metadata = object.metadata as Record<string, unknown> | undefined;
    const paymentIntent = object.payment_intent;
    const relatedIntentId = typeof paymentIntent === "string"
      ? paymentIntent
      : paymentIntent && typeof paymentIntent === "object" && "id" in paymentIntent && typeof paymentIntent.id === "string"
        ? paymentIntent.id
        : undefined;
    const belongsToAccount = metadata?.business_account_id === accountId
      || (typeof object.id === "string" && paymentIntentIds.has(object.id))
      || (relatedIntentId !== undefined && paymentIntentIds.has(relatedIntentId));
    if (!belongsToAccount) return [];
    return [{
      id: row.externalEventId,
      provider: "Stripe",
      type: row.eventType,
      deliveryCount: row.deliveryCount,
      firstReceivedAt: row.firstReceivedAt,
      lastReceivedAt: row.lastReceivedAt,
    }];
  });
  const plaidRows = plaidEvents.flatMap((row) => {
    const payload = row.payload as { accountId?: unknown };
    if (payload.accountId !== accountId) return [];
    return [{
      id: row.externalEventId,
      provider: "Plaid Transfer",
      type: row.eventType,
      deliveryCount: row.deliveryCount,
      firstReceivedAt: row.firstReceivedAt,
      lastReceivedAt: row.lastReceivedAt,
    }];
  });
  const events = [...stripeRows, ...plaidRows]
    .sort((left, right) => right.firstReceivedAt.getTime() - left.firstReceivedAt.getTime())
    .slice(0, 200);
  return Response.json({ events });
}
