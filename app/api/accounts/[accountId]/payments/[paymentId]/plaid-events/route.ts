import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { outboundPayments } from "@/lib/db/schema";
import { plaidPost } from "@/lib/plaid";
import { requireRoles } from "@/lib/auth";

type RouteProps = { params: Promise<{ accountId: string; paymentId: string }> };
type TransferResponse = { transfer: { id: string; status: string } };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedTransitions: Record<string, string[]> = {
  pending: ["posted"],
  posted: ["settled", "returned"],
  settled: ["returned"],
};

export async function POST(request: Request, { params }: RouteProps) {
  const denied = await requireRoles(["owner"]);
  if (denied) return denied;
  const { accountId, paymentId } = await params;
  if (!uuidPattern.test(accountId) || !uuidPattern.test(paymentId)) {
    return Response.json({ error: "Invalid account or payment ID." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const eventType = (body as { eventType?: unknown } | null)?.eventType;
  if (eventType !== "posted" && eventType !== "settled" && eventType !== "returned") {
    return Response.json({ error: "eventType must be posted, settled, or returned." }, { status: 400 });
  }

  const [payment] = await db.select().from(outboundPayments)
    .where(and(eq(outboundPayments.id, paymentId), eq(outboundPayments.accountId, accountId))).limit(1);
  if (!payment) return Response.json({ error: "Payment not found." }, { status: 404 });
  if (!payment.plaidTransferId) return Response.json({ error: "This payment does not have a Plaid Sandbox transfer yet." }, { status: 409 });

  const currentPlaidStatus = payment.plaidStatus ?? "pending";
  const replayingCurrentStatus = currentPlaidStatus === eventType;
  if (!replayingCurrentStatus && !allowedTransitions[currentPlaidStatus]?.includes(eventType)) {
    return Response.json({ error: "Plaid Sandbox cannot move this transfer from " + currentPlaidStatus + " to " + eventType + "." }, { status: 409 });
  }

  try {
    if (!replayingCurrentStatus) {
      await plaidPost("/sandbox/transfer/simulate", {
        transfer_id: payment.plaidTransferId,
        event_type: eventType,
      });
      const plaidTransfer = await plaidPost<TransferResponse>("/transfer/get", { transfer_id: payment.plaidTransferId });
      await db.update(outboundPayments)
        .set({ plaidStatus: plaidTransfer.transfer.status })
        .where(eq(outboundPayments.id, paymentId));
      if (plaidTransfer.transfer.status !== eventType) {
        return Response.json({ error: "Plaid transfer status did not update to " + eventType + "." }, { status: 502 });
      }
    }

    if (eventType === "settled" || eventType === "returned") {
      const cookie = request.headers.get("cookie") ?? "";
      const updateResponse = await fetch(new URL("/api/accounts/" + accountId + "/payments/" + paymentId + "/events", request.url), {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({
          status: eventType === "settled" ? "completed" : "returned",
          provider: "plaid-transfer",
          externalEventId: payment.plaidTransferId + ":" + eventType,
        }),
      });
      const updateResult = await updateResponse.json().catch(() => ({}));
      if (!updateResponse.ok) {
        return Response.json({ error: updateResult.error ?? "Plaid status updated, but the internal ledger could not be updated." }, { status: updateResponse.status });
      }
      return Response.json({ plaidStatus: eventType, ...updateResult });
    }

    return Response.json({ plaidStatus: eventType, paymentId });
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : "Could not simulate the Plaid transfer event." }, { status: 502 });
  }
}
