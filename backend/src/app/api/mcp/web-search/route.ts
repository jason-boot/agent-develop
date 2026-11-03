import { authenticated } from "@/lib/auth";
import { activateWebSearchMcpProvider, getPublicWebSearchMcpConfig, saveWebSearchMcpConfig } from "@/lib/web-search-mcp";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handlerGET() {
  try { return NextResponse.json(await getPublicWebSearchMcpConfig()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "读取网页搜索 MCP 配置失败。" }, { status: 500 }); }
}
export const GET = authenticated(handlerGET);

async function handlerPOST(request: Request) {
  try {
    const body = await request.json() as { action?: unknown; providerId?: unknown; apiKey?: unknown; activate?: unknown };
    const config = body.action === "activate"
      ? await activateWebSearchMcpProvider(body.providerId)
      : await saveWebSearchMcpConfig(body);
    return NextResponse.json(config);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存网页搜索 MCP 配置失败。" }, { status: 400 });
  }
}
export const POST = authenticated(handlerPOST);
