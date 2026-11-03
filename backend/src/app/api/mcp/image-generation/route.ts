import { authenticated } from "@/lib/auth";
import { getPublicImageGenerationMcpConfig, saveImageGenerationMcpConfig } from "@/lib/image-generation-mcp";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handlerGET() {
  try { return NextResponse.json(await getPublicImageGenerationMcpConfig()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "读取图片生成 MCP 配置失败。" }, { status: 500 }); }
}
export const GET = authenticated(handlerGET);

async function handlerPOST(request: Request) {
  try {
    const body = await request.json() as Parameters<typeof saveImageGenerationMcpConfig>[0];
    return NextResponse.json(await saveImageGenerationMcpConfig(body));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存图片生成 MCP 配置失败。" }, { status: 400 });
  }
}
export const POST = authenticated(handlerPOST);
