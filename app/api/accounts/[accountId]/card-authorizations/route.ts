import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { businessAccounts, cardHolds, cards, outboundPayments } from "@/lib/db/schema";
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

  const input = body as { cardId?: unknown; merchant?: unknown; amountCents?: unknown; externalAuthId?: unknown } | null;
  if (typeof input?.merchant !== "string" || input.merchant.trim().length < 1 || input.merchant.trim().length > 160) {
    return Response.json({ error: "merchant must be between 1 and 160 characters." }, { status: 400 });
  }
  if (typeof input.amountCents !== "number" || !Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    return Response.json({ error: "amountCents must be a positive integer." }, { status: 400 });
  }
  if (typeof input.externalAuthId !== "string" || input.externalAuthId.trim().length < 1 || input.externalAuthId.trim().length > 180) {
    return Response.json({ error: "externalAuthId must be between 1 and 180 characters." }, { status: 400 });
  }
  if (input.cardId !== undefined && (typeof input.cardId !== "string" || !uuidPattern.test(input.cardId))) {
    return Response.json({ error: "cardId must be a valid UUID." }, { status: 400 });
  }
  const merchant = input.merchant.trim();
  const amountCents = input.amountCents;
  const externalAuthId = input.externalAuthId.trim();
  const cardId = typeof input.cardId === "string" ? input.cardId : undefined;

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
      .from(cardHolds)
      .where(eq(cardHolds.externalAuthId, externalAuthId))
      .limit(1);
    if (existing) {
      if (existing.accountId !== accountId || existing.amountCents !== amountCents || existing.merchant !== merchant) {
        return { error: "Authorization ID already belongs to a different request.", status: 409 as const };
      }
      return { hold: existing, duplicate: true, status: 200 as const };
    }

    const [card] = await tx
      .select({ id: cards.id })
      .from(cards)
      .where(and(eq(cards.accountId, accountId), eq(cards.active, true), cardId ? eq(cards.id, cardId) : sql`true`))
      .limit(1);
    if (!card) return { error: "Active card not found.", status: 404 as const };

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
      return { error: "Insufficient available funds.", status: 409 as const, availableBalanceCents: totals?.availableCents ?? 0 };
    }

    const [hold] = await tx
      .insert(cardHolds)
      .values({ accountId, cardId: card.id, merchant, amountCents, externalAuthId })
      .returning();

    return { hold, duplicate: false, status: 201 as const };
  });

  if ("error" in result) return Response.json(result, { status: result.status });
  return Response.json({ hold: result.hold, duplicate: result.duplicate }, { status: result.status });
}
