import { createDesktopOAuthUrl } from "@/lib/auth";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ provider: string }> };
export async function GET(request: Request, { params }: RouteContext) {
  try { return createDesktopOAuthUrl(request, (await params).provider); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "无法开始远程授权。" }, { status: 503 }); }
}
