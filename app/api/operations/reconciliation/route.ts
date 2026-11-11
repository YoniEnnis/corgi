import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businessAccounts, externalRecords, ledgerEntries, reconciliationActions } from "@/lib/db/schema";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sameWindow = (left: Date, right: Date, hours: number) => Math.abs(left.getTime() - right.getTime()) <= hours * 60 * 60 * 1000;
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

export async function GET(request: Request) {
  const accountId = new URL(request.url).searchParams.get("accountId");
  if (!accountId || !uuidPattern.test(accountId)) {
    return Response.json({ error: "Provide a valid accountId query parameter." }, { status: 400 });
  }

  const [account] = await db
    .select({ id: businessAccounts.id, name: businessAccounts.name, currency: businessAccounts.currency })
    .from(businessAccounts)
    .where(and(eq(businessAccounts.id, accountId), eq(businessAccounts.active, true)))
    .limit(1);
  if (!account) return Response.json({ error: "Account not found." }, { status: 404 });

  const [records, entries, actions] = await Promise.all([
    db.select().from(externalRecords).where(eq(externalRecords.accountId, accountId)).orderBy(externalRecords.occurredAt),
    db.select().from(ledgerEntries).where(eq(ledgerEntries.accountId, accountId)).orderBy(ledgerEntries.createdAt),
    db.select().from(reconciliationActions).where(eq(reconciliationActions.accountId, accountId)).orderBy(reconciliationActions.createdAt),
  ]);

  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const claimedEntryIds = new Set(records.flatMap((record) => record.matchedLedgerEntryId ? [record.matchedLedgerEntryId] : []));
  const report = records.map((record) => {
    const linkedEntry = record.matchedLedgerEntryId ? entryById.get(record.matchedLedgerEntryId) : undefined;
    const recordActions = actions.filter((action) => action.externalRecordId === record.id);
    const correctionActions = recordActions.filter((action) => action.action === "correction");
    const correctionsCents = correctionActions.reduce((sum, action) => sum + (action.amountCents ?? 0), 0);

    if (linkedEntry) {
      const reconciledAmountCents = linkedEntry.amountCents + correctionsCents;
      const matched = record.currency === account.currency && record.amountCents === reconciledAmountCents;
      return {
        externalRecord: record,
        status: matched ? "matched" : "mismatched",
        ledgerEntry: linkedEntry,
        actions: recordActions,
        corrections: correctionActions,
        reconciledAmountCents,
        differenceCents: record.amountCents - reconciledAmountCents,
      };
    }

    const eligibleEntries = entries.filter((entry) => !claimedEntryIds.has(entry.id));
    const exactCandidates = record.currency === account.currency
      ? eligibleEntries.filter((entry) => entry.amountCents === record.amountCents && sameWindow(entry.createdAt, record.occurredAt, 48))
      : [];
    if (exactCandidates.length === 1) {
      claimedEntryIds.add(exactCandidates[0].id);
      return { externalRecord: record, status: "match_suggested", candidateLedgerEntry: exactCandidates[0], actions: recordActions, corrections: correctionActions };
    }

    const externalName = normalize(record.description);
    const mismatchCandidates = eligibleEntries.filter((entry) => {
      const localName = normalize(entry.description);
      return externalName.length > 0 && localName.length > 0
        && (localName.includes(externalName) || externalName.includes(localName))
        && sameWindow(entry.createdAt, record.occurredAt, 72);
    });
    if (mismatchCandidates.length === 1) {
      claimedEntryIds.add(mismatchCandidates[0].id);
      return {
        externalRecord: record,
        status: "mismatch_suggested",
        candidateLedgerEntry: mismatchCandidates[0],
        actions: recordActions,
        corrections: correctionActions,
        differenceCents: record.amountCents - mismatchCandidates[0].amountCents - correctionsCents,
      };
    }

    return { externalRecord: record, status: "external_only", actions: recordActions, corrections: correctionActions };
  });

  const internalOnly = entries.filter((entry) => !claimedEntryIds.has(entry.id));
  const summary = {
    externalRecords: report.length,
    matched: report.filter((row) => row.status === "matched").length,
    mismatched: report.filter((row) => row.status === "mismatched" || row.status === "mismatch_suggested").length,
    matchSuggested: report.filter((row) => row.status === "match_suggested").length,
    externalOnly: report.filter((row) => row.status === "external_only").length,
    internalOnly: internalOnly.length,
  };

  return Response.json({ account, summary, externalRecords: report, internalOnly });
}
