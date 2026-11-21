import { NextResponse } from "next/server";
import { initDb, verifyLogin } from "@/lib/db";
import { SESSION_COOKIE, signSession } from "@/lib/session";

initDb();

export async function POST(req: Request) {
  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const username = body.username ?? "";
  const password = body.password ?? "";
  const user = verifyLogin(username, password);
  if (!user) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, username: user.username });
  res.cookies.set(SESSION_COOKIE, signSession(user.id), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  return res;
}
