import { authenticated } from "@/lib/auth";
import { NextResponse } from "next/server";
import { findModel, requestModelCompletion, type ModelConfig } from "@/lib/model-config";

export const runtime = "nodejs";

async function handlerPOST(request: Request) {
  try {
    const body = await request.json() as Partial<ModelConfig> & { credentialSourceModelId?: string };
    const saved = body.id ? await findModel(body.id) : null;
    const credentialSource = body.credentialSourceModelId ? await findModel(body.credentialSourceModelId) : null;
    const config: ModelConfig = {
      id: body.id || "connection-test", name: body.name || saved?.name || "连接测试",
      protocol: body.protocol || saved?.protocol || "chat",
      fullAddress: body.fullAddress ?? saved?.fullAddress ?? false,
      baseUrl: body.baseUrl?.trim() || saved?.baseUrl || "", model: body.model?.trim() || saved?.model || "",
      apiKey: body.apiKey?.trim() || saved?.apiKey || credentialSource?.apiKey || "",
      vendor: body.vendor || saved?.vendor || "custom", modelsUrl: body.modelsUrl || saved?.modelsUrl || "",
    };
    if (!config.baseUrl || !config.model || !config.apiKey) return NextResponse.json({ error: "请先填写 API 地址、模型 ID 和 API Key。" }, { status: 400 });
    await requestModelCompletion(config, [{ role: "user", content: "请只回复 OK。" }], 8);
    return NextResponse.json({ ok: true, message: "连接成功，模型已返回响应。" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "连接测试失败。" }, { status: 502 });
  }
}
export const POST = authenticated(handlerPOST);
