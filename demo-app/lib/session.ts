import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "vigil_session";

// Dev fallback only; set SESSION_SECRET in the environment for anything real.
const SECRET = process.env.SESSION_SECRET ?? "vigil-dev-only-secret-not-for-production";

export function signSession(userId: number): string {
  const payload = String(userId);
  const sig = createHmac("sha256", SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function verifySession(token: string | undefined): number | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", SECRET).update(payload).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const userId = Number(payload);
  return Number.isInteger(userId) ? userId : null;
}

/** Returns the logged-in user's id, or null. Reads the HttpOnly cookie. */
export async function getSessionUserId(): Promise<number | null> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}
