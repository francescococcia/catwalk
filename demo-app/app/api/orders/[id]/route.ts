import { NextResponse } from "next/server";
import { getOrderById, initDb } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";

initDb();

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Auth check IS present: you must be logged in.
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const { id } = await params;

  // VULNERABILITY (deliberate, for the Vigil demo): no ownership check.
  // Any logged-in user can read ANY order by changing the id in the URL.
  // The fix is: getOrderByIdForUser(id, userId) -> WHERE id = ? AND user_id = ?
  const order = getOrderById(id);
  if (!order) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }

  return NextResponse.json(order);
}
