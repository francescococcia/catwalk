import { getSessionUserId } from "@/lib/session";
export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return new Response("no", { status: 401 });
  return Response.json({ orders: getOrdersForUser(userId) });
}
