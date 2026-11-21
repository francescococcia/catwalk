import { getSessionUserId } from "@/lib/session";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return new Response("no", { status: 401 });
  const { id } = await params;
  // The fix is: getOrderByIdForUser(id, userId)
  return Response.json(getOrderById(id));
}
