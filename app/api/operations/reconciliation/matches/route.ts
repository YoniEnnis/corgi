import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businessAccounts, externalRecords, ledgerEntries, reconciliationActions } from "@/lib/db/schema";
import { requireRoles } from "@/lib/auth";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const denied = await requireRoles(["operations"]);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const input = body as { accountId?: unknown; externalRecordId?: unknown; ledgerEntryId?: unknown; reason?: unknown } | null;
  if (typeof input?.accountId !== "string" || !uuidPattern.test(input.accountId)
    || typeof input.externalRecordId !== "string" || !uuidPattern.test(input.externalRecordId)
    || typeof input.ledgerEntryId !== "string" || !uuidPattern.test(input.ledgerEntryId)) {
    return Response.json({ error: "accountId, externalRecordId, and ledgerEntryId must be valid UUIDs." }, { status: 400 });
  }
  if (typeof input.reason !== "string" || input.reason.trim().length < 3 || input.reason.trim().length > 500) {
    return Response.json({ error: "reason must be between 3 and 500 characters." }, { status: 400 });
  }

  const accountId = input.accountId as string;
  const externalRecordId = input.externalRecordId as string;
  const ledgerEntryId = input.ledgerEntryId as string;
  const reason = (input.reason as string).trim();
  const result = await db.transaction(async (tx) => {
    const [account] = await tx
      .select({ id: businessAccounts.id, currency: businessAccounts.currency })
      .from(businessAccounts)
      .where(and(eq(businessAccounts.id, accountId), eq(businessAccounts.active, true)))
      .for("update")
      .limit(1);
    if (!account) return { error: "Account not found.", status: 404 as const };

    const [record] = await tx
      .select()
      .from(externalRecords)
      .where(and(eq(externalRecords.id, externalRecordId), eq(externalRecords.accountId, accountId)))
      .for("update")
      .limit(1);
    if (!record) return { error: "External record not found for this account.", status: 404 as const };
    if (record.matchedLedgerEntryId) return { error: "External record is already linked to a ledger entry.", status: 409 as const };

    const [entry] = await tx
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.id, ledgerEntryId), eq(ledgerEntries.accountId, accountId)))
      .limit(1);
    if (!entry) return { error: "Ledger entry not found for this account.", status: 404 as const };

    await tx.update(externalRecords).set({ matchedLedgerEntryId: entry.id }).where(eq(externalRecords.id, record.id));
    const [action] = await tx
      .insert(reconciliationActions)
      .values({ accountId, action: "manual_match", externalRecordId: record.id, ledgerEntryId: entry.id, reason })
      .returning();

    return {
      action,
      match: {
        externalAmountCents: record.amountCents,
        ledgerAmountCents: entry.amountCents,
        amountMatches: record.amountCents === entry.amountCents,
        currencyMatches: record.currency === account.currency,
      },
      status: 201 as const,
    };
  });

  const { status, ...bodyResult } = result;
  return Response.json(bodyResult, { status });
}
