import { cookies } from "next/headers";
import { sessionCookieName, sessionCookieOptions } from "@/lib/auth";

export async function POST() {
  (await cookies()).set(sessionCookieName, "", { ...sessionCookieOptions(), maxAge: 0 });
  return Response.json({ loggedOut: true });
}
