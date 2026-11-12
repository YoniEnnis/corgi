import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businessAccounts, outboundPayments, plaidConnections, processedEvents } from "@/lib/db/schema";
import { decryptPlaidAccessToken, plaidPost } from "@/lib/plaid";

type TransferAuthorization = {
  authorization: { id: string; decision: "approved" | "declined" | "user_action_required"; decision_rationale?: { code: string | null } };
};
type PlaidTransfer = { transfer: { id: string; status: string } };

function plaidAmount(cents: number) {
  return (cents / 100).toFixed(2);
}

export async function createPlaidTransferIfConnected(accountId: string, paymentId: string) {
  const [row] = await db
    .select({
      payment: outboundPayments,
      accountName: businessAccounts.name,
      encryptedToken: plaidConnections.accessTokenEncrypted,
      plaidAccountId: plaidConnections.plaidAccountId,
    })
    .from(outboundPayments)
    .innerJoin(businessAccounts, eq(outboundPayments.accountId, businessAccounts.id))
    .leftJoin(plaidConnections, eq(plaidConnections.accountId, businessAccounts.id))
    .where(eq(outboundPayments.id, paymentId))
    .limit(1);

  if (!row || row.payment.accountId !== accountId) throw new Error("Payment not found.");
  if (!row.encryptedToken || !row.plaidAccountId) return { payment: row.payment, connected: false };
  if (row.payment.plaidTransferId) return { payment: row.payment, connected: true };
  if (row.payment.status !== "pending") throw new Error("This payment is no longer pending and cannot create a Plaid transfer.");

  const accessToken = decryptPlaidAccessToken(row.encryptedToken);
  let authorizationId = row.payment.plaidAuthorizationId;
  if (!authorizationId) {
    const authorizationResult = await plaidPost<TransferAuthorization>("/transfer/authorization/create", {
      access_token: accessToken,
      account_id: row.plaidAccountId,
      type: "credit",
      network: "ach",
      amount: plaidAmount(row.payment.amountCents),
      ach_class: "ccd",
      user: { legal_name: row.accountName },
      idempotency_key: "corgi-auth-" + row.payment.id,
      user_present: true,
    });
    const authorization = authorizationResult.authorization;
    if (authorization.decision !== "approved") {
      const reason = authorization.decision_rationale?.code ?? authorization.decision;
      const payload = {
        accountId,
        paymentId,
        status: "failed",
        plaidDecision: authorization.decision,
        rationale: authorization.decision_rationale?.code ?? null,
      };
      await db.transaction(async (tx) => {
        const [currentPayment] = await tx.select({ status: outboundPayments.status })
          .from(outboundPayments)
          .where(eq(outboundPayments.id, paymentId))
          .for("update")
          .limit(1);
        if (!currentPayment || currentPayment.status !== "pending") return;
        await tx.insert(processedEvents).values({
          provider: "plaid-transfer",
          externalEventId: authorization.id + ":declined",
          eventType: "outbound_payment.failed",
          payload,
        }).onConflictDoNothing();
        await tx.update(outboundPayments)
          .set({ status: "failed", plaidAuthorizationId: authorization.id, plaidStatus: authorization.decision })
          .where(eq(outboundPayments.id, paymentId));
      });
      throw new Error("Plaid declined this payout (" + reason + "). The app released its reservation. Plaid's payout ledger balance is separate from the app balance.");
    }
    authorizationId = authorization.id;
    await db.update(outboundPayments)
      .set({ plaidAuthorizationId: authorizationId })
      .where(eq(outboundPayments.id, paymentId));
  }

  const transferResult = await plaidPost<PlaidTransfer>("/transfer/create", {
    access_token: accessToken,
    account_id: row.plaidAccountId,
    authorization_id: authorizationId,
    description: "PAYMENT",
    metadata: { app_payment_id: row.payment.id, recipient: row.payment.recipient.slice(0, 40) },
  });
  const [payment] = await db.update(outboundPayments)
    .set({
      plaidAuthorizationId: authorizationId,
      plaidTransferId: transferResult.transfer.id,
      plaidStatus: transferResult.transfer.status,
    })
    .where(eq(outboundPayments.id, paymentId))
    .returning();
  return { payment, connected: true };
}
