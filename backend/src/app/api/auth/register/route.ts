import { registerWithPassword } from "@/lib/auth";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try { return await registerWithPassword(request); }
  catch (error) { console.error("User registration failed", error); return Response.json({ error: "注册失败，请稍后重试。" }, { status: 500 }); }
}
