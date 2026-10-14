import { authenticated } from "@/lib/auth";
import { listConversations } from "@/lib/local-db";

export const runtime = "nodejs";

async function handlerGET(request: Request) {
  try { return Response.json({ conversations: await listConversations() }); }
  catch (error) {
    console.error("List conversations failed", error);
    return Response.json({ error: "读取本地会话失败。" }, { status: 500 });
  }
}
export const GET = authenticated(handlerGET);
