import { authenticated } from "@/lib/auth";
import { ensureVideoGenerationTaskPoller, listVideoGenerationTasks } from "@/lib/video-generation-mcp";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handlerGET(request: Request) {
  try {
    const conversationId = new URL(request.url).searchParams.get("conversationId") || "";
    ensureVideoGenerationTaskPoller();
    return NextResponse.json({ tasks: await listVideoGenerationTasks(conversationId) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取视频生成任务失败。" }, { status: 400 });
  }
}

export const GET = authenticated(handlerGET);
