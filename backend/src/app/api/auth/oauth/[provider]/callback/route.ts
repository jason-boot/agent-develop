import { completeOAuthLogin } from "@/lib/auth";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ provider: string }> };
export async function GET(request: Request, { params }: RouteContext) {
  try { return await completeOAuthLogin(request, (await params).provider); }
  catch (error) { console.error("Third-party OAuth callback failed", error); return new Response("第三方登录失败，请稍后重试。", { status: 502 }); }
}
