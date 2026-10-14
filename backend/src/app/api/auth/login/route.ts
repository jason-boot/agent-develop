import { loginWithPassword } from "@/lib/auth";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try { return await loginWithPassword(request); }
  catch (error) { console.error("User login failed", error); return Response.json({ error: "登录失败，请稍后重试。" }, { status: 500 }); }
}
