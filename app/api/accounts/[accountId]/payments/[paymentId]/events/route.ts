import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { businessAccounts, ledgerEntries, outboundPayments, processedEvents } from "@/lib/db/schema";

type RouteProps = { params: Promise<{ accountId: string; paymentId: string }> };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: RouteProps) {
  const { accountId, paymentId } = await params;
  if (!uuidPattern.test(accountId) || !uuidPattern.test(paymentId)) {
    return Response.json({ error: "Invalid account or payment ID." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const input = body as { status?: unknown; provider?: unknown; externalEventId?: unknown } | null;
  if (input?.status !== "completed" && input?.status !== "returned") {
    return Response.json({ error: "status must be completed or returned." }, { status: 400 });
  }
  const targetStatus = input.status as "completed" | "returned";
  if (typeof input.provider !== "string" || input.provider.trim().length < 1 || input.provider.trim().length > 80) {
    return Response.json({ error: "provider must be between 1 and 80 characters." }, { status: 400 });
  }
  if (typeof input.externalEventId !== "string" || input.externalEventId.trim().length < 1 || input.externalEventId.trim().length > 180) {
    return Response.json({ error: "externalEventId must be between 1 and 180 characters." }, { status: 400 });
  }

  const provider = input.provider.trim();
  const externalEventId = input.externalEventId.trim();
  const payload = { accountId, paymentId, status: targetStatus };

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
        && previousPayload.paymentId === paymentId
        && previousPayload.status === targetStatus;
      return payloadMatches
        ? { duplicate: true, payloadMatches, eventId: previousEvent.id, status: 200 as const }
        : { error: "This provider event ID was already used for different payment details.", duplicate: true, payloadMatches, status: 409 as const };
    }

    const [payment] = await tx
      .select()
      .from(outboundPayments)
      .where(and(eq(outboundPayments.id, paymentId), eq(outboundPayments.accountId, accountId)))
      .for("update")
      .limit(1);
    if (!payment) return { error: "Payment not found.", status: 404 as const };

    const validTransition = payment.status === "pending"
      || (payment.status === "completed" && targetStatus === "returned");
    if (!validTransition) return { error: `Payment cannot transition from ${payment.status} to ${targetStatus}.`, status: 409 as const };
    if (payment.status === targetStatus) return { error: `Payment is already ${targetStatus}.`, status: 409 as const };

    const [event] = await tx
      .insert(processedEvents)
      .values({ provider, externalEventId, eventType: `outbound_payment.${targetStatus}`, payload })
      .onConflictDoNothing()
      .returning({ id: processedEvents.id });
    if (!event) {
      const [racedEvent] = await tx
        .select()
        .from(processedEvents)
        .where(and(eq(processedEvents.provider, provider), eq(processedEvents.externalEventId, externalEventId)))
        .limit(1);
      if (!racedEvent) throw new Error("Payment event conflict could not be resolved.");
      await tx
        .update(processedEvents)
        .set({ deliveryCount: sql`${processedEvents.deliveryCount} + 1`, lastReceivedAt: new Date() })
        .where(eq(processedEvents.id, racedEvent.id));
      const racedPayload = racedEvent.payload as typeof payload;
      const payloadMatches = racedPayload.accountId === accountId
        && racedPayload.paymentId === paymentId
        && racedPayload.status === targetStatus;
      return payloadMatches
        ? { duplicate: true, payloadMatches, eventId: racedEvent.id, status: 200 as const }
        : { error: "This provider event ID was already used for different payment details.", duplicate: true, payloadMatches, status: 409 as const };
    }

    let completedEntryId = payment.completedEntryId;
    let returnedEntryId = payment.returnedEntryId;

    if (targetStatus === "completed") {
      const [entry] = await tx
        .insert(ledgerEntries)
        .values({
          accountId,
          type: "outbound_payment",
          amountCents: -payment.amountCents,
          description: `Payment to ${payment.recipient}`,
          idempotencyKey: `provider-event:${event.id}`,
        })
        .returning({ id: ledgerEntries.id });
      completedEntryId = entry.id;
    } else if (payment.status === "completed") {
      if (!payment.completedEntryId) throw new Error("Completed payment is missing its ledger entry.");
      const [entry] = await tx
        .insert(ledgerEntries)
        .values({
          accountId,
          type: "payment_return",
          amountCents: payment.amountCents,
          description: `Return of payment to ${payment.recipient}`,
          idempotencyKey: `provider-event:${event.id}`,
          reversalOfId: payment.completedEntryId,
        })
        .returning({ id: ledgerEntries.id });
      returnedEntryId = entry.id;
    }

    const now = new Date();
    const [updatedPayment] = await tx
      .update(outboundPayments)
      .set({
        status: targetStatus,
        completedAt: targetStatus === "completed" ? now : payment.completedAt,
        returnedAt: targetStatus === "returned" ? now : payment.returnedAt,
        completedEntryId,
        returnedEntryId,
      })
      .where(eq(outboundPayments.id, paymentId))
      .returning();

    return { duplicate: false, eventId: event.id, payment: updatedPayment, status: 201 as const };
  });

  const { status, ...bodyResult } = result;
  return Response.json(bodyResult, { status });
}
