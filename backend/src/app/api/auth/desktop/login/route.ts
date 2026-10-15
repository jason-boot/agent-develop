import { loginDesktopForHandoff } from "@/lib/auth";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try { return await loginDesktopForHandoff(request); }
  catch (error) { console.error("Desktop login failed", error); return Response.json({ error: "远程登录失败，请稍后重试。" }, { status: 502 }); }
}
