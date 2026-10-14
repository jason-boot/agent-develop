import { createOAuthLoginUrl } from "@/lib/auth";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ provider: string }> };
export async function GET(request: Request, { params }: RouteContext) {
  try { return createOAuthLoginUrl(request, (await params).provider); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "第三方登录暂不可用。" }, { status: 503 }); }
}
