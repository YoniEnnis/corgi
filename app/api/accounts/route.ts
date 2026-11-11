import { db } from "@/lib/db";
import { businessAccounts, cards } from "@/lib/db/schema";

export async function GET() {
  const accounts = await db
    .select({ id: businessAccounts.id, name: businessAccounts.name, currency: businessAccounts.currency })
    .from(businessAccounts)
    .where(businessAccounts.active);

  return Response.json({ accounts });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const name = (body as { name?: unknown } | null)?.name;
  if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 120) {
    return Response.json({ error: "Account name must be between 2 and 120 characters." }, { status: 400 });
  }

  const account = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(businessAccounts)
      .values({ name: name.trim() })
      .returning({ id: businessAccounts.id, name: businessAccounts.name, currency: businessAccounts.currency });

    await tx.insert(cards).values({ accountId: created.id, lastFour: "4821" });
    return created;
  });

  return Response.json({ account }, { status: 201 });
}
