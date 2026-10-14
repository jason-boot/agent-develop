import { listConversations } from "@/lib/local-db";

export const runtime = "nodejs";

export async function GET() {
  try { return Response.json({ conversations: await listConversations() }); }
  catch (error) {
    console.error("List conversations failed", error);
    return Response.json({ error: "读取本地会话失败。" }, { status: 500 });
  }
}
