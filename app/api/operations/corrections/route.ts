import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businessAccounts, externalRecords, ledgerEntries, reconciliationActions } from "@/lib/db/schema";
import { requireRoles } from "@/lib/auth";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const denied = await requireRoles(["operations"]);
  if (denied) return denied;

  const headerKey = request.headers.get("Idempotency-Key")?.trim();
  if (!headerKey || headerKey.length > 176) {
    return Response.json({ error: "Provide an Idempotency-Key header (up to 176 characters)." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const input = body as { accountId?: unknown; amountCents?: unknown; reason?: unknown; externalRecordId?: unknown } | null;
  if (typeof input?.accountId !== "string" || !uuidPattern.test(input.accountId)) {
    return Response.json({ error: "accountId must be a valid UUID." }, { status: 400 });
  }
  if (typeof input.amountCents !== "number" || !Number.isSafeInteger(input.amountCents) || input.amountCents === 0) {
    return Response.json({ error: "amountCents must be a non-zero integer." }, { status: 400 });
  }
  if (typeof input.reason !== "string" || input.reason.trim().length < 3 || input.reason.trim().length > 500) {
    return Response.json({ error: "reason must be between 3 and 500 characters." }, { status: 400 });
  }
  if (input.externalRecordId !== undefined && (typeof input.externalRecordId !== "string" || !uuidPattern.test(input.externalRecordId))) {
    return Response.json({ error: "externalRecordId must be a valid UUID." }, { status: 400 });
  }

  const accountId = input.accountId as string;
  const amountCents = input.amountCents as number;
  const reason = (input.reason as string).trim();
  const externalRecordId = input.externalRecordId as string | undefined;
  const idempotencyKey = `ops:${headerKey}`;
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
      .from(ledgerEntries)
      .where(eq(ledgerEntries.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existing) {
      const [existingAction] = await tx
        .select({ externalRecordId: reconciliationActions.externalRecordId })
        .from(reconciliationActions)
        .where(and(eq(reconciliationActions.ledgerEntryId, existing.id), eq(reconciliationActions.action, "correction")))
        .limit(1);
      const sameReason = existing.description === `Operations correction: ${reason}`.slice(0, 240);
      const sameExternalRecord = (existingAction?.externalRecordId ?? undefined) === externalRecordId;
      if (existing.accountId !== accountId || existing.type !== "correction" || existing.amountCents !== amountCents || !sameReason || !sameExternalRecord) {
        return { error: "Idempotency key already belongs to a different correction.", status: 409 as const };
      }
      return { entry: existing, duplicate: true, status: 200 as const };
    }

    let linkedExternalRecordId: string | undefined;
    if (externalRecordId) {
      const [record] = await tx
        .select({ id: externalRecords.id })
        .from(externalRecords)
        .where(and(eq(externalRecords.id, externalRecordId), eq(externalRecords.accountId, accountId)))
        .limit(1);
      if (!record) return { error: "External record not found for this account.", status: 404 as const };
      linkedExternalRecordId = record.id;
    }

    const [entry] = await tx
      .insert(ledgerEntries)
      .values({
        accountId,
        type: "correction",
        amountCents,
        description: `Operations correction: ${reason}`.slice(0, 240),
        idempotencyKey,
      })
      .returning();

    await tx.insert(reconciliationActions).values({
      accountId,
      action: "correction",
      externalRecordId: linkedExternalRecordId,
      ledgerEntryId: entry.id,
      amountCents,
      reason,
    });

    return { entry, duplicate: false, status: 201 as const };
  });

  const { status, ...bodyResult } = result;
  return Response.json(bodyResult, { status });
}
