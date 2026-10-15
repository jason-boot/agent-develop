import { completeDesktopOAuthCallback } from "@/lib/auth";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try { return await completeDesktopOAuthCallback(request); }
  catch (error) { console.error("Desktop OAuth callback failed", error); return new Response("桌面授权失败，请返回应用重试。", { status: 502 }); }
}
