import { getSession } from "@/lib/auth";
import { removeUserIdentity } from "@/lib/local-db";

export const runtime = "nodejs";

export async function DELETE(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const user = await getSession(request);
  if (!user) return Response.json({ error: "请先登录。" }, { status: 401 });
  const { provider } = await params;
  if (!["github", "gitee", "google"].includes(provider)) return Response.json({ error: "不支持的第三方平台。" }, { status: 400 });
  try {
    const removed = await removeUserIdentity(user.id, provider);
    if (!removed) return Response.json({ error: "该第三方账号尚未绑定。" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    console.error("OAuth identity removal failed", error);
    return Response.json({ error: "解绑失败，请稍后重试。" }, { status: 500 });
  }
}
