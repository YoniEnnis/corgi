import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { cardHolds } from "@/lib/db/schema";
import { requireRoles } from "@/lib/auth";
import { stripeGet, stripePost } from "@/lib/stripe";

type RouteProps = { params: Promise<{ accountId: string; holdId: string }> };
type PaymentIntent = { id: string; status: string; amount_received: number; livemode: boolean };
type Refund = { id: string; status: string | null; livemode: boolean };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: RouteProps) {
  const denied = await requireRoles(["owner"]);
  if (denied) return denied;
  if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
    return Response.json({ error: "Set STRIPE_SECRET_KEY to a Stripe test-mode key." }, { status: 503 });
  }

  const { accountId, holdId } = await params;
  if (!uuidPattern.test(accountId) || !uuidPattern.test(holdId)) return Response.json({ error: "Invalid account or hold ID." }, { status: 400 });
  let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const input = body as { action?: unknown; amountCents?: unknown } | null;
  if (input?.action !== "capture" && input?.action !== "refund") return Response.json({ error: "action must be capture or refund." }, { status: 400 });

  const [hold] = await db.select().from(cardHolds)
    .where(and(eq(cardHolds.id, holdId), eq(cardHolds.accountId, accountId))).limit(1);
  if (!hold) return Response.json({ error: "Card authorization not found." }, { status: 404 });
  if (!hold.externalAuthId.startsWith("pi_")) return Response.json({ error: "This hold is not a Stripe Payments authorization." }, { status: 409 });

  try {
    if (input.action === "capture") {
      if (typeof input.amountCents !== "number" || !Number.isSafeInteger(input.amountCents) || input.amountCents < 50 || input.amountCents > hold.amountCents) {
        return Response.json({ error: "Capture amount must be at least $0.50 and cannot exceed the authorized amount." }, { status: 400 });
      }
      if (hold.status === "settled") {
        if (hold.settledAmountCents !== input.amountCents) return Response.json({ error: "This authorization was already captured for a different amount." }, { status: 409 });
        return Response.json({ paymentIntentId: hold.externalAuthId, amountCents: hold.settledAmountCents, duplicate: true });
      }
      if (hold.status !== "open") return Response.json({ error: "This authorization is no longer open." }, { status: 409 });

      let intent = await stripeGet<PaymentIntent>(`payment_intents/${hold.externalAuthId}`);
      if (intent.livemode) return Response.json({ error: "Refusing to capture a live Stripe payment." }, { status: 409 });
      if (intent.status === "requires_capture") {
        intent = await stripePost<PaymentIntent>(`payment_intents/${hold.externalAuthId}/capture`, {
          amount_to_capture: String(input.amountCents),
        }, `corgi-capture-${hold.externalAuthId}`);
      }
      if (intent.status !== "succeeded" || intent.amount_received !== input.amountCents) {
        return Response.json({ error: "Stripe did not confirm the requested capture amount." }, { status: 409 });
      }
      return Response.json({ paymentIntentId: intent.id, amountCents: intent.amount_received, duplicate: false });
    }

    if (hold.status !== "settled" || !hold.settledAmountCents) return Response.json({ error: "Capture this authorization before refunding it." }, { status: 409 });
    const refund = await stripePost<Refund>("refunds", {
      payment_intent: hold.externalAuthId,
      amount: String(hold.settledAmountCents),
      reason: "requested_by_customer",
    }, `corgi-refund-${hold.externalAuthId}`);
    if (refund.livemode || refund.status !== "succeeded") {
      return Response.json({ error: `Stripe refund is not complete (status: ${refund.status ?? "unknown"}).` }, { status: 409 });
    }
    return Response.json({ refundId: refund.id, duplicate: false });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Stripe could not complete this card action." }, { status: 502 });
  }
}
