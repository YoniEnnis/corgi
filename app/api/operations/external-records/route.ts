import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businessAccounts, externalRecords } from "@/lib/db/schema";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const input = body as {
    accountId?: unknown;
    provider?: unknown;
    externalRecordId?: unknown;
    amountCents?: unknown;
    currency?: unknown;
    occurredAt?: unknown;
    description?: unknown;
  } | null;
  if (typeof input?.accountId !== "string" || !uuidPattern.test(input.accountId)) {
    return Response.json({ error: "accountId must be a valid UUID." }, { status: 400 });
  }
  if (typeof input.provider !== "string" || input.provider.trim().length < 1 || input.provider.trim().length > 80) {
    return Response.json({ error: "provider must be between 1 and 80 characters." }, { status: 400 });
  }
  if (typeof input.externalRecordId !== "string" || input.externalRecordId.trim().length < 1 || input.externalRecordId.trim().length > 180) {
    return Response.json({ error: "externalRecordId must be between 1 and 180 characters." }, { status: 400 });
  }
  if (typeof input.amountCents !== "number" || !Number.isSafeInteger(input.amountCents) || input.amountCents === 0) {
    return Response.json({ error: "amountCents must be a non-zero integer." }, { status: 400 });
  }
  const currency = input.currency ?? "USD";
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    return Response.json({ error: "currency must be a three-letter uppercase code." }, { status: 400 });
  }
  if (typeof input.occurredAt !== "string" || Number.isNaN(Date.parse(input.occurredAt))) {
    return Response.json({ error: "occurredAt must be a valid ISO date string." }, { status: 400 });
  }
  if (typeof input.description !== "string" || input.description.trim().length < 1 || input.description.trim().length > 240) {
    return Response.json({ error: "description must be between 1 and 240 characters." }, { status: 400 });
  }

  const [account] = await db
    .select({ id: businessAccounts.id })
    .from(businessAccounts)
    .where(and(eq(businessAccounts.id, input.accountId), eq(businessAccounts.active, true)))
    .limit(1);
  if (!account) return Response.json({ error: "Account not found." }, { status: 404 });

  const values = {
    accountId: input.accountId,
    provider: input.provider.trim(),
    externalRecordId: input.externalRecordId.trim(),
    amountCents: input.amountCents,
    currency,
    occurredAt: new Date(input.occurredAt),
    description: input.description.trim(),
  };
  const [record] = await db
    .insert(externalRecords)
    .values(values)
    .onConflictDoNothing()
    .returning();
  if (record) return Response.json({ record, duplicate: false }, { status: 201 });

  const [existing] = await db
    .select()
    .from(externalRecords)
    .where(and(eq(externalRecords.provider, values.provider), eq(externalRecords.externalRecordId, values.externalRecordId)))
    .limit(1);
  if (!existing) return Response.json({ error: "External record conflict could not be resolved." }, { status: 409 });

  const sameRecord = existing.accountId === values.accountId
    && existing.amountCents === values.amountCents
    && existing.currency === values.currency
    && existing.description === values.description
    && existing.occurredAt.getTime() === values.occurredAt.getTime();
  if (!sameRecord) return Response.json({ error: "External record ID already exists with different details." }, { status: 409 });

  return Response.json({ record: existing, duplicate: true });
}
