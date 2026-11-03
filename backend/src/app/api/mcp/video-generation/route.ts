import { authenticated } from "@/lib/auth";
import { getPublicVideoGenerationConfig, saveVideoGenerationConfig } from "@/lib/video-generation-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handlerGET() {
  try { return Response.json(await getPublicVideoGenerationConfig()); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "读取视频生成配置失败。" }, { status: 500 }); }
}
export const GET = authenticated(handlerGET);

async function handlerPOST(request: Request) {
  try {
    const body = await request.json() as Parameters<typeof saveVideoGenerationConfig>[0];
    return Response.json(await saveVideoGenerationConfig(body));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "保存视频生成配置失败。" }, { status: 400 });
  }
}
export const POST = authenticated(handlerPOST);
