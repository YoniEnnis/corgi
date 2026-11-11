import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { processedEvents } from "@/lib/db/schema";
import { verifyStripeSignature } from "@/lib/stripe";

type StripeEvent = {
  id: string;
  type: string;
  livemode: boolean;
  data: { object: Record<string, unknown> };
};

export async function POST(request: Request) {
  if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
    return Response.json({ error: "Stripe test mode is not configured." }, { status: 503 });
  }
  const rawBody = await request.text();
  let event: StripeEvent;
  try { event = JSON.parse(rawBody) as StripeEvent; }
  catch { return Response.json({ error: "Invalid Stripe event JSON." }, { status: 400 }); }
  if (!event.id || !event.type || event.livemode !== false || !event.data?.object) {
    return Response.json({ error: "Only valid Stripe sandbox events are accepted." }, { status: 400 });
  }
  if (!verifyStripeSignature(rawBody, request.headers.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET)) {
    return Response.json({ error: "Invalid Stripe signature." }, { status: 400 });
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [inserted] = await tx.insert(processedEvents).values({
        provider: "stripe",
        externalEventId: event.id,
        eventType: event.type,
        payload: event as never,
      }).onConflictDoNothing().returning({ id: processedEvents.id });
      if (inserted) return { duplicate: false };

      const [existing] = await tx.select({ id: processedEvents.id }).from(processedEvents)
        .where(and(eq(processedEvents.provider, "stripe"), eq(processedEvents.externalEventId, event.id))).limit(1);
      if (!existing) throw new Error("Could not resolve duplicate Stripe event.");
      await tx.update(processedEvents)
        .set({ deliveryCount: sql`${processedEvents.deliveryCount} + 1`, lastReceivedAt: new Date() })
        .where(eq(processedEvents.id, existing.id));
      return { duplicate: true };
    });
    return Response.json({ received: true, ...result });
  } catch {
    return Response.json({ error: "Could not record the Stripe event." }, { status: 500 });
  }
}
