import { createOAuthLoginUrl } from "@/lib/auth";

export const runtime = "nodejs";
export function GET(request: Request) {
  try { return createOAuthLoginUrl(request, "github"); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub 登录暂不可用。" }, { status: 503 }); }
}
