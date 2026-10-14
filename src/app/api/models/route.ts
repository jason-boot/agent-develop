import { NextResponse } from "next/server";
import { discoverProviderModels, findLatestProviderConfig, listPublicModels, removeModel, saveModel, saveModelsBatch, setDefaultModel } from "@/lib/model-config";

export const runtime = "nodejs";

export async function GET() {
  try { return NextResponse.json(await listPublicModels()); }
  catch { return NextResponse.json({ error: "读取模型配置失败。" }, { status: 500 }); }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: string; id?: string; model?: string; models?: Array<{ name: string; model: string }>; name?: string; vendor?: string; protocol?: "chat" | "messages" | "responses"; modelsUrl?: string; baseUrl?: string; fullAddress?: boolean; apiKey?: string; credentialSourceModelId?: string };
    if (body.action === "default") return NextResponse.json(await setDefaultModel(body.id || null));
    if (body.action === "latest-provider") {
      const config = await findLatestProviderConfig(body.vendor || "");
      if (!config) return NextResponse.json({ error: "没有找到该厂商已保存的配置。" }, { status: 404 });
      return NextResponse.json(config);
    }
    if (body.action === "discover") {
      const models = await discoverProviderModels({ vendor: body.vendor, modelsUrl: body.modelsUrl || "", apiKey: body.apiKey || "", credentialSourceModelId: body.credentialSourceModelId });
      return NextResponse.json({ models });
    }
    if (body.action === "batch") {
      return NextResponse.json(await saveModelsBatch({ protocol: body.protocol || "chat", baseUrl: body.baseUrl || "", fullAddress: body.fullAddress, apiKey: body.apiKey || "", name: body.name || "", vendor: body.vendor, modelsUrl: body.modelsUrl, credentialSourceModelId: body.credentialSourceModelId, models: body.models || [] }));
    }
    if (body.action === "delete") {
      if (!body.id) return NextResponse.json({ error: "缺少模型 ID。" }, { status: 400 });
      return NextResponse.json(await removeModel(body.id));
    }
    return NextResponse.json(await saveModel(body));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存模型配置失败。" }, { status: 400 });
  }
}
