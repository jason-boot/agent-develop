import { completeOAuthLogin } from "@/lib/auth";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try { return await completeOAuthLogin(request, "github"); }
  catch (error) { console.error("GitHub OAuth callback failed", error); return new Response("GitHub 登录失败，请稍后重试。", { status: 502 }); }
}
