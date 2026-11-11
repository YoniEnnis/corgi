import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { businessAccounts, cardHolds, cards, outboundPayments } from "@/lib/db/schema";
import { requireRoles } from "@/lib/auth";
import { stripePost } from "@/lib/stripe";

type RouteProps = { params: Promise<{ accountId: string }> };
type PaymentIntent = { id: string; status: string; livemode: boolean };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: RouteProps) {
  const denied = await requireRoles(["owner"]);
  if (denied) return denied;
  if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
    return Response.json({ error: "Set STRIPE_SECRET_KEY to a Stripe test-mode key." }, { status: 503 });
  }

  const { accountId } = await params;
  if (!uuidPattern.test(accountId)) return Response.json({ error: "Invalid account ID." }, { status: 400 });
  let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const input = body as { merchant?: unknown; amountCents?: unknown; requestId?: unknown } | null;
  if (typeof input?.merchant !== "string" || input.merchant.trim().length < 1 || input.merchant.trim().length > 160) {
    return Response.json({ error: "Merchant must be between 1 and 160 characters." }, { status: 400 });
  }
  if (typeof input.amountCents !== "number" || !Number.isSafeInteger(input.amountCents) || input.amountCents < 50) {
    return Response.json({ error: "Stripe card payments must be at least $0.50 USD." }, { status: 400 });
  }
  if (typeof input.requestId !== "string" || !uuidPattern.test(input.requestId)) {
    return Response.json({ error: "requestId must be a UUID." }, { status: 400 });
  }

  const merchant = input.merchant.trim();
  const amountCents = input.amountCents;
  const requestId = input.requestId;
  const [account] = await db.select({ id: businessAccounts.id, currency: businessAccounts.currency })
    .from(businessAccounts)
    .where(and(eq(businessAccounts.id, accountId), eq(businessAccounts.active, true)))
    .limit(1);
  if (!account) return Response.json({ error: "Account not found." }, { status: 404 });
  if (account.currency !== "USD") return Response.json({ error: "Stripe test card payments currently support USD accounts only." }, { status: 409 });
  const [card] = await db.select({ id: cards.id }).from(cards)
    .where(and(eq(cards.accountId, accountId), eq(cards.active, true))).limit(1);
  if (!card) return Response.json({ error: "Active account card not found." }, { status: 404 });

  try {
    const intent = await stripePost<PaymentIntent>("payment_intents", {
      amount: String(amountCents),
      currency: "usd",
      "automatic_payment_methods[enabled]": "true",
      "automatic_payment_methods[allow_redirects]": "never",
      payment_method: "pm_card_visa",
      capture_method: "manual",
      confirm: "true",
      description: merchant,
      "metadata[business_account_id]": accountId,
      "metadata[internal_card_id]": card.id,
      "metadata[demo_request_id]": requestId,
    }, `corgi-card-auth-${accountId}-${requestId}`);

    if (intent.livemode || intent.status !== "requires_capture") {
      return Response.json({ error: `Stripe test authorization did not enter manual-capture state (status: ${intent.status}).` }, { status: 409 });
    }

    const result = await db.transaction(async (tx) => {
      const [lockedAccount] = await tx.select({ id: businessAccounts.id }).from(businessAccounts)
        .where(and(eq(businessAccounts.id, accountId), eq(businessAccounts.active, true))).for("update").limit(1);
      if (!lockedAccount) return { error: "Account not found.", status: 404 as const };
      const [existing] = await tx.select().from(cardHolds).where(eq(cardHolds.externalAuthId, intent.id)).limit(1);
      if (existing) return { hold: existing, duplicate: true, status: 200 as const };

      const [totals] = await tx.select({
        availableCents: sql<number>`(
          coalesce((select sum(amount_cents) from ledger_entries where account_id = ${accountId} and available_at <= now()), 0)
          - coalesce((select sum(amount_cents) from card_holds where account_id = ${accountId} and status = 'open'), 0)
          - coalesce((select sum(amount_cents) from outbound_payments where account_id = ${accountId} and status = 'pending'), 0)
        )::bigint`.mapWith(Number),
      }).from(businessAccounts).where(eq(businessAccounts.id, accountId));
      if (!totals || totals.availableCents < amountCents) return { error: "Insufficient available funds for this authorization.", status: 409 as const };

      const [hold] = await tx.insert(cardHolds).values({
        accountId,
        cardId: card.id,
        merchant,
        amountCents,
        externalAuthId: intent.id,
      }).returning();
      return { hold, duplicate: false, status: 201 as const };
    });

    if ("error" in result) {
      try { await stripePost<PaymentIntent>(`payment_intents/${intent.id}/cancel`, {}, `corgi-cancel-${intent.id}`); }
      catch { return Response.json({ error: `${result.error} Stripe could not cancel the test authorization; review it in the Stripe Dashboard.` }, { status: 502 }); }
      return Response.json({ error: result.error }, { status: result.status });
    }
    return Response.json({ hold: result.hold, duplicate: result.duplicate }, { status: result.status });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not create Stripe test authorization." }, { status: 502 });
  }
}
