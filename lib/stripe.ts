import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

type StripeError = { error?: { message?: string } };

function secretKey() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key?.startsWith("sk_test_")) throw new Error("Set STRIPE_SECRET_KEY to a Stripe test-mode key.");
  return key;
}

export async function stripePost<T>(path: string, values: Record<string, string>, idempotencyKey: string): Promise<T> {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idempotencyKey,
    },
    body: new URLSearchParams(values),
    cache: "no-store",
  });
  const result = await response.json() as T & StripeError;
  if (!response.ok) throw new Error(result.error?.message ?? `Stripe request failed (${response.status}).`);
  return result;
}

export async function stripeGet<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${secretKey()}` },
    cache: "no-store",
  });
  const result = await response.json() as T & StripeError;
  if (!response.ok) throw new Error(result.error?.message ?? `Stripe request failed (${response.status}).`);
  return result;
}

export function verifyStripeSignature(rawBody: string, signatureHeader: string | null, signingSecret: string | undefined) {
  if (!signingSecret || !signatureHeader) return false;
  const parts = signatureHeader.split(",").map((part) => part.split("=", 2));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const expected = createHmac("sha256", signingSecret).update(`${timestamp}.${rawBody}`).digest();
  return signatures.some((signature) => {
    if (!signature || !/^[a-f0-9]+$/i.test(signature)) return false;
    const received = Buffer.from(signature, "hex");
    return received.length === expected.length && timingSafeEqual(received, expected);
  });
}
