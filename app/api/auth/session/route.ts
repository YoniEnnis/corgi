import { getSession } from "@/lib/auth";

export async function GET() {
  const session = await getSession();
  return Response.json({ user: session ? { email: session.email, role: session.role } : null });
}
