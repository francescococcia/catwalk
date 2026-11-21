import { getSessionUserId } from "@/lib/session";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return new Response("no", { status: 401 });
  const order = getOrderById((await params).id);
  if (!order || order.user_id !== userId) return new Response("not found", { status: 404 });
  return Response.json(order);
}
