import { NextResponse } from "next/server";
import { getOrdersForUser, initDb } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";

initDb();

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // This route is correctly scoped to the session user.
  return NextResponse.json({ orders: getOrdersForUser(userId) });
}
