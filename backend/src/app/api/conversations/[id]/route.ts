import { authenticated } from "@/lib/auth";
import { deleteConversation, getConversation, saveConversation, setConversationPinned, type StoredMessage } from "@/lib/local-db";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

async function handlerGET(_request: Request, { params }: RouteContext) {
  try {
    const { id } = await params;
    const conversation = await getConversation(id);
    return conversation ? Response.json({ conversation }) : Response.json({ error: "未找到该会话。" }, { status: 404 });
  } catch (error) {
    console.error("Read conversation failed", error);
    return Response.json({ error: "读取本地会话失败。" }, { status: 500 });
  }
}
export const GET = authenticated(handlerGET);

async function handlerPUT(request: Request, { params }: RouteContext) {
  try {
    const { id } = await params;
    const body = await request.json() as { title?: unknown; messages?: unknown; projectId?: unknown; projectName?: unknown };
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return Response.json({ error: "会话编号无效。" }, { status: 400 });
    if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 200 || !Array.isArray(body.messages) || body.messages.length > 500) {
      return Response.json({ error: "会话内容格式无效。" }, { status: 400 });
    }
    const messages: StoredMessage[] = [];
    for (const item of body.messages) {
      if (!item || typeof item !== "object") return Response.json({ error: "会话消息格式无效。" }, { status: 400 });
      const message = item as Record<string, unknown>;
      if ((message.role !== "assistant" && message.role !== "user") || typeof message.content !== "string" || message.content.length > 100_000) {
        return Response.json({ error: "会话消息格式无效。" }, { status: 400 });
      }
      messages.push({
        role: message.role,
        content: message.content,
        ...(message.error === true ? { error: true } : {}),
        ...(message.result !== undefined ? { result: message.result } : {}),
      });
    }
    if (body.projectId !== undefined && body.projectId !== null && (typeof body.projectId !== "string" || body.projectId.length > 100)) return Response.json({ error: "项目编号无效。" }, { status: 400 });
    if (body.projectName !== undefined && body.projectName !== null && (typeof body.projectName !== "string" || body.projectName.length > 200)) return Response.json({ error: "项目名称无效。" }, { status: 400 });
    const updatedAt = await saveConversation(id, body.title.trim(), messages, typeof body.projectId === "string" ? body.projectId : undefined, typeof body.projectName === "string" ? body.projectName : undefined);
    return Response.json({ updatedAt });
  } catch (error) {
    console.error("Save conversation failed", error);
    return Response.json({ error: "保存本地会话失败。" }, { status: 500 });
  }
}
export const PUT = authenticated(handlerPUT);

async function handlerPATCH(request: Request, { params }: RouteContext) {
  try {
    const { id } = await params;
    const body = await request.json() as { pinned?: unknown };
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || typeof body.pinned !== "boolean") return Response.json({ error: "置顶状态无效。" }, { status: 400 });
    if (!await setConversationPinned(id, body.pinned)) return Response.json({ error: "未找到该会话。" }, { status: 404 });
    return Response.json({ pinned: body.pinned });
  } catch (error) {
    console.error("Update conversation pin failed", error);
    return Response.json({ error: "更新会话置顶状态失败。" }, { status: 500 });
  }
}
export const PATCH = authenticated(handlerPATCH);

async function handlerDELETE(_request: Request, { params }: RouteContext) {
  try {
    const { id } = await params;
    return Response.json({ deleted: await deleteConversation(id) });
  } catch (error) {
    console.error("Delete conversation failed", error);
    return Response.json({ error: "删除本地会话失败。" }, { status: 500 });
  }
}
export const DELETE = authenticated(handlerDELETE);
