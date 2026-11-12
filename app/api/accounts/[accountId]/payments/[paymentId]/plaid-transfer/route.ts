import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { outboundPayments } from "@/lib/db/schema";
import { createPlaidTransferIfConnected } from "@/lib/plaid-transfers";
import { requireRoles } from "@/lib/auth";

type RouteProps = { params: Promise<{ accountId: string; paymentId: string }> };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(_request: Request, { params }: RouteProps) {
  const denied = await requireRoles(["owner"]);
  if (denied) return denied;
  const { accountId, paymentId } = await params;
  if (!uuidPattern.test(accountId) || !uuidPattern.test(paymentId)) {
    return Response.json({ error: "Invalid account or payment ID." }, { status: 400 });
  }
  const [payment] = await db.select({ id: outboundPayments.id })
    .from(outboundPayments)
    .where(eq(outboundPayments.id, paymentId))
    .limit(1);
  if (!payment) return Response.json({ error: "Payment not found." }, { status: 404 });

  try {
    const result = await createPlaidTransferIfConnected(accountId, paymentId);
    if (!result.connected) return Response.json({ error: "Connect a Plaid Sandbox bank account first." }, { status: 409 });
    return Response.json({ payment: result.payment });
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : "Could not create the Plaid Sandbox transfer." }, { status: 502 });
  }
}
