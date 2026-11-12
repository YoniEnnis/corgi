import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businessAccounts, plaidConnections } from "@/lib/db/schema";
import { encryptPlaidAccessToken, isPlaidConfigured, plaidPost } from "@/lib/plaid";
import { requireRoles } from "@/lib/auth";

type RouteProps = { params: Promise<{ accountId: string }> };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: RouteProps) {
  const denied = await requireRoles(["owner"]);
  if (denied) return denied;
  const { accountId } = await params;
  if (!uuidPattern.test(accountId)) return Response.json({ error: "Invalid account ID." }, { status: 400 });

  const [connection] = await db
    .select({ institutionName: plaidConnections.institutionName, accountName: plaidConnections.accountName, accountMask: plaidConnections.accountMask, createdAt: plaidConnections.createdAt })
    .from(plaidConnections)
    .where(eq(plaidConnections.accountId, accountId))
    .limit(1);
  let ledgerBalance: { name: string; available: string; pending: string } | null = null;
  let ledgerError: string | null = null;
  if (isPlaidConfigured() && connection) {
    try {
      const result = await plaidPost<{ name: string; balance: { available: string; pending: string } }>("/transfer/ledger/get", {});
      ledgerBalance = { name: result.name, ...result.balance };
    } catch (cause) {
      ledgerError = cause instanceof Error ? cause.message : "Could not read the Plaid Sandbox ledger balance.";
    }
  }
  return Response.json({ configured: isPlaidConfigured(), connected: Boolean(connection), connection: connection ?? null, ledgerBalance, ledgerError });
}

export async function POST(_request: Request, { params }: RouteProps) {
  const denied = await requireRoles(["owner"]);
  if (denied) return denied;
  const { accountId } = await params;
  if (!uuidPattern.test(accountId)) return Response.json({ error: "Invalid account ID." }, { status: 400 });
  if (!isPlaidConfigured()) return Response.json({ error: "Plaid Sandbox is not configured. Check PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV=sandbox." }, { status: 503 });

  try {
    const [account] = await db.select({ id: businessAccounts.id })
      .from(businessAccounts)
      .where(and(eq(businessAccounts.id, accountId), eq(businessAccounts.active, true)))
      .limit(1);
    if (!account) return Response.json({ error: "Account not found." }, { status: 404 });

    const [existing] = await db.select({ institutionName: plaidConnections.institutionName, accountName: plaidConnections.accountName, accountMask: plaidConnections.accountMask, createdAt: plaidConnections.createdAt })
      .from(plaidConnections)
      .where(eq(plaidConnections.accountId, accountId))
      .limit(1);
    if (existing) return Response.json({ connected: true, connection: existing, duplicate: true });

    const tokenResult = await plaidPost<{ public_token: string }>("/sandbox/public_token/create", {
      institution_id: "ins_109508",
      initial_products: ["transfer"],
      options: { override_username: "user_good", override_password: "pass_good" },
    });
    const exchangeResult = await plaidPost<{ access_token: string }>("/item/public_token/exchange", { public_token: tokenResult.public_token });
    const accountsResult = await plaidPost<{ accounts: Array<{ account_id: string; name: string; mask: string | null }> }>("/accounts/get", { access_token: exchangeResult.access_token });
    const linkedAccount = accountsResult.accounts[0];
    if (!linkedAccount) return Response.json({ error: "Plaid Sandbox returned no bank accounts." }, { status: 502 });

    const [saved] = await db.insert(plaidConnections).values({
      accountId,
      accessTokenEncrypted: encryptPlaidAccessToken(exchangeResult.access_token),
      plaidAccountId: linkedAccount.account_id,
      institutionName: "First Platypus Bank",
      accountName: linkedAccount.name,
      accountMask: linkedAccount.mask,
    }).onConflictDoNothing({ target: plaidConnections.accountId })
      .returning({ institutionName: plaidConnections.institutionName, accountName: plaidConnections.accountName, accountMask: plaidConnections.accountMask, createdAt: plaidConnections.createdAt });
    if (saved) return Response.json({ connected: true, connection: saved }, { status: 201 });

    const [raced] = await db.select({ institutionName: plaidConnections.institutionName, accountName: plaidConnections.accountName, accountMask: plaidConnections.accountMask, createdAt: plaidConnections.createdAt })
      .from(plaidConnections).where(eq(plaidConnections.accountId, accountId)).limit(1);
    if (!raced) throw new Error("Could not save the Plaid Sandbox connection.");
    return Response.json({ connected: true, connection: raced, duplicate: true });
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : "Could not connect a Plaid Sandbox account." }, { status: 502 });
  }
}
