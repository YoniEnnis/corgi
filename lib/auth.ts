import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export type AppRole = "owner" | "operations";
export type SessionUser = { email: string; role: AppRole; expiresAt: number };

const COOKIE_NAME = "morrow_session";
const SESSION_LIFETIME_SECONDS = 60 * 60 * 8;
const localDefaults = process.env.NODE_ENV === "development";

function credentials(role: AppRole) {
  const isOwner = role === "owner";
  return {
    email: (isOwner ? process.env.DEMO_OWNER_EMAIL : process.env.DEMO_OPERATIONS_EMAIL)
      ?? (localDefaults ? (isOwner ? "owner@example.test" : "ops@example.test") : ""),
    password: (isOwner ? process.env.DEMO_OWNER_PASSWORD : process.env.DEMO_OPERATIONS_PASSWORD)
      ?? (localDefaults ? (isOwner ? "Owner-demo-123!" : "Ops-demo-123!") : ""),
  };
}

function sessionSecret() {
  return process.env.SESSION_SECRET
    ?? (localDefaults ? "local-only-session-secret-change-before-deploy" : "");
}

export function isAuthConfigured() {
  return Boolean(sessionSecret() && credentials("owner").email && credentials("owner").password
    && credentials("operations").email && credentials("operations").password);
}

function constantTimeEqual(left: string, right: string) {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function authenticate(email: string, password: string): Omit<SessionUser, "expiresAt"> | null {
  const normalizedEmail = email.trim().toLowerCase();
  for (const role of ["owner", "operations"] as const) {
    const configured = credentials(role);
    if (normalizedEmail === configured.email.trim().toLowerCase() && constantTimeEqual(password, configured.password)) {
      return { email: configured.email, role };
    }
  }
  return null;
}

export function createSessionToken(user: Omit<SessionUser, "expiresAt">) {
  const session: SessionUser = { ...user, expiresAt: Date.now() + SESSION_LIFETIME_SECONDS * 1000 };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return { token: `${payload}.${signature}`, session };
}

export async function getSession(): Promise<SessionUser | null> {
  if (!isAuthConfigured()) return null;
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;

  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  if (!constantTimeEqual(signature, expected)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionUser;
    if ((session.role !== "owner" && session.role !== "operations") || typeof session.email !== "string"
      || typeof session.expiresAt !== "number" || session.expiresAt <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

export async function requireRoles(allowedRoles: AppRole[]) {
  const session = await getSession();
  if (!session) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  if (!allowedRoles.includes(session.role)) return Response.json({ error: "You do not have access to this action." }, { status: 403 });
  return null;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge: SESSION_LIFETIME_SECONDS,
  };
}

export const sessionCookieName = COOKIE_NAME;
