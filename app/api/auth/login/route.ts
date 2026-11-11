import { cookies } from "next/headers";
import { authenticate, createSessionToken, isAuthConfigured, sessionCookieName, sessionCookieOptions } from "@/lib/auth";

export async function POST(request: Request) {
  if (!isAuthConfigured()) {
    return Response.json({ error: "Authentication is not configured for this deployment." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const input = body as { email?: unknown; password?: unknown } | null;
  if (typeof input?.email !== "string" || input.email.length > 200 || typeof input.password !== "string" || input.password.length > 200) {
    return Response.json({ error: "Enter a valid email and password." }, { status: 400 });
  }

  const user = authenticate(input.email, input.password);
  if (!user) return Response.json({ error: "Email or password is incorrect." }, { status: 401 });

  const { token } = createSessionToken(user);
  (await cookies()).set(sessionCookieName, token, sessionCookieOptions());
  return Response.json({ user: { email: user.email, role: user.role } });
}
