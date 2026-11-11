import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { businessAccounts, cardHolds, ledgerEntries, outboundPayments } from "@/lib/db/schema";
import { requireRoles } from "@/lib/auth";

type RouteProps = { params: Promise<{ accountId: string }> };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: RouteProps) {
  const denied = await requireRoles(["owner"]);
  if (denied) return denied;

  const { accountId } = await params;
  if (!uuidPattern.test(accountId)) return Response.json({ error: "Invalid account ID." }, { status: 400 });

  const payments = await db
    .select()
    .from(outboundPayments)
    .where(eq(outboundPayments.accountId, accountId))
    .orderBy(desc(outboundPayments.createdAt));

  return Response.json({ payments });
}

export async function POST(request: Request, { params }: RouteProps) {
  const denied = await requireRoles(["owner"]);
  if (denied) return denied;

  const { accountId } = await params;
  if (!uuidPattern.test(accountId)) return Response.json({ error: "Invalid account ID." }, { status: 400 });

  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 180) {
    return Response.json({ error: "Provide an Idempotency-Key header (up to 180 characters)." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const input = body as { recipient?: unknown; amountCents?: unknown } | null;
  if (typeof input?.recipient !== "string" || input.recipient.trim().length < 1 || input.recipient.trim().length > 160) {
    return Response.json({ error: "recipient must be between 1 and 160 characters." }, { status: 400 });
  }
  if (typeof input.amountCents !== "number" || !Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    return Response.json({ error: "amountCents must be a positive integer." }, { status: 400 });
  }
  const recipient = input.recipient.trim();
  const amountCents = input.amountCents;

  const result = await db.transaction(async (tx) => {
    const [account] = await tx
      .select({ id: businessAccounts.id })
      .from(businessAccounts)
      .where(and(eq(businessAccounts.id, accountId), eq(businessAccounts.active, true)))
      .for("update")
      .limit(1);
    if (!account) return { error: "Account not found.", status: 404 as const };

    const [existing] = await tx
      .select()
      .from(outboundPayments)
      .where(eq(outboundPayments.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existing) {
      if (existing.accountId !== accountId || existing.amountCents !== amountCents || existing.recipient !== recipient) {
        return { error: "Idempotency key already belongs to a different payment request.", status: 409 as const };
      }
      return { payment: existing, duplicate: true, status: 200 as const };
    }

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
    if (!totals || totals.availableCents < amountCents) {
      return { error: "Insufficient available funds.", availableBalanceCents: totals?.availableCents ?? 0, status: 409 as const };
    }

    const [payment] = await tx
      .insert(outboundPayments)
      .values({ accountId, recipient, amountCents, idempotencyKey })
      .onConflictDoNothing()
      .returning();
    if (!payment) {
      const [racedPayment] = await tx.select().from(outboundPayments).where(eq(outboundPayments.idempotencyKey, idempotencyKey)).limit(1);
      if (!racedPayment || racedPayment.accountId !== accountId || racedPayment.amountCents !== amountCents || racedPayment.recipient !== recipient) {
        return { error: "Idempotency key already belongs to a different payment request.", status: 409 as const };
      }
      return { payment: racedPayment, duplicate: true, status: 200 as const };
    }

    return { payment, duplicate: false, status: 201 as const };
  });

  const { status, ...bodyResult } = result;
  return Response.json(bodyResult, { status });
}
