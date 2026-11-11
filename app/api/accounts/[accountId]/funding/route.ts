import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businessAccounts, ledgerEntries } from "@/lib/db/schema";

type RouteProps = { params: Promise<{ accountId: string }> };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: RouteProps) {
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

  const input = body as { amountCents?: unknown; availableAt?: unknown; description?: unknown } | null;
  const amountCents = input?.amountCents;
  if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return Response.json({ error: "amountCents must be a positive integer." }, { status: 400 });
  }

  let availableAt = new Date();
  if (input?.availableAt !== undefined) {
    if (typeof input.availableAt !== "string" || Number.isNaN(Date.parse(input.availableAt))) {
      return Response.json({ error: "availableAt must be a valid ISO date string." }, { status: 400 });
    }
    availableAt = new Date(input.availableAt);
  }

  const description = input?.description ?? "Incoming funds";
  if (typeof description !== "string" || description.trim().length < 1 || description.trim().length > 240) {
    return Response.json({ error: "description must be between 1 and 240 characters." }, { status: 400 });
  }

  const [account] = await db
    .select({ id: businessAccounts.id })
    .from(businessAccounts)
    .where(and(eq(businessAccounts.id, accountId), eq(businessAccounts.active, true)))
    .limit(1);
  if (!account) return Response.json({ error: "Account not found." }, { status: 404 });

  const [entry] = await db
    .insert(ledgerEntries)
    .values({
      accountId,
      type: "funding",
      amountCents,
      description: description.trim(),
      availableAt,
      idempotencyKey,
    })
    .onConflictDoNothing({ target: ledgerEntries.idempotencyKey })
    .returning();

  if (entry) return Response.json({ entry, duplicate: false }, { status: 201 });

  const [existing] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.idempotencyKey, idempotencyKey)).limit(1);
  if (!existing || existing.accountId !== accountId || existing.type !== "funding") {
    return Response.json({ error: "Idempotency key already belongs to a different request." }, { status: 409 });
  }

  return Response.json({ entry: existing, duplicate: true });
}
