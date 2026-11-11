import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { businessAccounts, cardHolds, ledgerEntries, outboundPayments, processedEvents } from "@/lib/db/schema";
import { requireRoles } from "@/lib/auth";

type RouteProps = { params: Promise<{ accountId: string }> };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: RouteProps) {
  const denied = await requireRoles(["owner"]);
  if (denied) return denied;

  const { accountId } = await params;
  if (!uuidPattern.test(accountId)) return Response.json({ error: "Invalid account ID." }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const input = body as { holdId?: unknown; amountCents?: unknown; provider?: unknown; externalEventId?: unknown } | null;
  if (typeof input?.holdId !== "string" || !uuidPattern.test(input.holdId)) {
    return Response.json({ error: "holdId must be a valid UUID." }, { status: 400 });
  }
  if (typeof input.amountCents !== "number" || !Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    return Response.json({ error: "amountCents must be a positive integer." }, { status: 400 });
  }
  if (typeof input.provider !== "string" || input.provider.trim().length < 1 || input.provider.trim().length > 80) {
    return Response.json({ error: "provider must be between 1 and 80 characters." }, { status: 400 });
  }
  if (typeof input.externalEventId !== "string" || input.externalEventId.trim().length < 1 || input.externalEventId.trim().length > 180) {
    return Response.json({ error: "externalEventId must be between 1 and 180 characters." }, { status: 400 });
  }

  const holdId = input.holdId as string;
  const amountCents = input.amountCents as number;
  const provider = input.provider.trim();
  const externalEventId = input.externalEventId.trim();
  const payload = { accountId, holdId, amountCents };

  const result = await db.transaction(async (tx) => {
    const [account] = await tx
      .select({ id: businessAccounts.id })
      .from(businessAccounts)
      .where(and(eq(businessAccounts.id, accountId), eq(businessAccounts.active, true)))
      .for("update")
      .limit(1);
    if (!account) return { error: "Account not found.", status: 404 as const };

    const [previousEvent] = await tx
      .select()
      .from(processedEvents)
      .where(and(eq(processedEvents.provider, provider), eq(processedEvents.externalEventId, externalEventId)))
      .limit(1);
    if (previousEvent) {
      await tx
        .update(processedEvents)
        .set({ deliveryCount: sql`${processedEvents.deliveryCount} + 1`, lastReceivedAt: new Date() })
        .where(eq(processedEvents.id, previousEvent.id));

      const previousPayload = previousEvent.payload as typeof payload;
      const payloadMatches = previousPayload.accountId === accountId
        && previousPayload.holdId === holdId
        && previousPayload.amountCents === amountCents;
      return payloadMatches
        ? { duplicate: true, payloadMatches, eventId: previousEvent.id, status: 200 as const }
        : { error: "This provider event ID was already used for different settlement details.", duplicate: true, payloadMatches, status: 409 as const };
    }

    const [hold] = await tx
      .select()
      .from(cardHolds)
      .where(and(eq(cardHolds.id, holdId), eq(cardHolds.accountId, accountId)))
      .for("update")
      .limit(1);
    if (!hold) return { error: "Card authorization not found.", status: 404 as const };
    if (hold.status !== "open") return { error: "Card authorization is already closed.", status: 409 as const };

    const [totals] = await tx
      .select({
        availableCents: sql<number>`(
          coalesce((select sum(amount_cents) from ledger_entries where account_id = ${accountId} and available_at <= now()), 0)
          - coalesce((select sum(amount_cents) from card_holds where account_id = ${accountId} and status = 'open'), 0)
          - coalesce((select sum(amount_cents) from outbound_payments where account_id = ${accountId} and status = 'pending'), 0)
        )::bigint`.mapWith(Number),
      })
      .from(businessAccounts)
      .where(eq(businessAccounts.id, accountId));

    const availableAfterSettlement = (totals?.availableCents ?? 0) + hold.amountCents - amountCents;
    if (availableAfterSettlement < 0) {
      return { error: "Settlement exceeds the hold and remaining available funds.", status: 409 as const };
    }

    const [event] = await tx
      .insert(processedEvents)
      .values({ provider, externalEventId, eventType: "card.settled", payload })
      .onConflictDoNothing()
      .returning({ id: processedEvents.id });

    if (!event) {
      const [racedEvent] = await tx
        .select()
        .from(processedEvents)
        .where(and(eq(processedEvents.provider, provider), eq(processedEvents.externalEventId, externalEventId)))
        .limit(1);
      if (!racedEvent) throw new Error("Settlement event conflict could not be resolved.");
      await tx
        .update(processedEvents)
        .set({ deliveryCount: sql`${processedEvents.deliveryCount} + 1`, lastReceivedAt: new Date() })
        .where(eq(processedEvents.id, racedEvent.id));
      const racedPayload = racedEvent.payload as typeof payload;
      const payloadMatches = racedPayload.accountId === accountId
        && racedPayload.holdId === holdId
        && racedPayload.amountCents === amountCents;
      return payloadMatches
        ? { duplicate: true, payloadMatches, eventId: racedEvent.id, status: 200 as const }
        : { error: "This provider event ID was already used for different settlement details.", duplicate: true, payloadMatches, status: 409 as const };
    }

    const [entry] = await tx
      .insert(ledgerEntries)
      .values({
        accountId,
        type: "card_settlement",
        amountCents: -amountCents,
        description: `${hold.merchant} card purchase settled`,
        idempotencyKey: `provider-event:${event.id}`,
      })
      .returning();

    const [updatedHold] = await tx
      .update(cardHolds)
      .set({ status: "settled", settledAmountCents: amountCents, settlementEntryId: entry.id, closedAt: new Date() })
      .where(eq(cardHolds.id, hold.id))
      .returning();

    return { duplicate: false, eventId: event.id, entry, hold: updatedHold, status: 201 as const };
  });

  const { status, ...bodyResult } = result;
  return Response.json(bodyResult, { status });
}
