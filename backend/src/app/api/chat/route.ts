import { authenticated } from "@/lib/auth";
import { NextResponse } from "next/server";
import { answerQuestion } from "@/lib/agent";
import { findModel, getModelStore, ModelServiceError, type AgentImageInput } from "@/lib/model-config";

export const runtime = "nodejs";

const maxImagesPerMessage = 4;
const maxImageDataLength = 6 * 1024 * 1024;
const maxTotalImageDataLength = 18 * 1024 * 1024;
const maxProjectBytes = 8_000_000;

function chatErrorMessage(error: unknown) {
  if (error instanceof ModelServiceError) return error.message;
  if (process.env.NODE_ENV !== "production" && error instanceof Error) return `智能体处理失败：${error.message}`;
  return "智能体处理请求时发生错误，请稍后重试；如果问题持续，请查看服务端日志。";
}

function parseProjectFiles(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelServiceError("项目文件数据格式无效，请重新打开项目目录。");
  const entries = Object.entries(value as Record<string, unknown>);
  let totalBytes = 0;
  const files: Record<string, string> = {};
  for (const [path, content] of entries) {
    if (typeof content !== "string" || !path || path.length > 500 || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".." || ["__proto__", "prototype", "constructor"].includes(part))) throw new ModelServiceError("项目文件路径无效，请重新打开项目目录。");
    if (/^\.env/i.test(path) || /(^|\/)(node_modules|\.git|\.next|dist|build|coverage)(\/|$)/.test(path) || /(^|\/)(id_rsa|id_ed25519|credentials|secrets?)(\.|$)/i.test(path)) continue;
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > maxProjectBytes) throw new ModelServiceError("项目可读文本总量超过 8 MB，请排除生成文件或大型数据文件后重试。");
    files[path] = content;
  }
  return files;
}

function parseImages(value: unknown, currentTotal: number): { images: AgentImageInput[]; total: number } {
  if (value === undefined) return { images: [], total: currentTotal };
  if (!Array.isArray(value) || value.length > maxImagesPerMessage) throw new ModelServiceError("每条消息最多添加 4 张图片。");
  let total = currentTotal;
  const images = value.map((item) => {
    if (!item || typeof item !== "object" || typeof (item as Record<string, unknown>).dataUrl !== "string") throw new ModelServiceError("图片数据格式无效，请重新选择图片。");
    const dataUrl = (item as { dataUrl: string }).dataUrl;
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match || dataUrl.length > maxImageDataLength) throw new ModelServiceError("仅支持不超过 4 MB 的 JPG、PNG 或 WebP 图片。");
    total += dataUrl.length;
    if (total > maxTotalImageDataLength) throw new ModelServiceError("本次对话携带的图片过多，请移除部分图片后重试。");
    return { mimeType: match[1] as AgentImageInput["mimeType"], dataUrl };
  });
  return { images, total };
}

async function handlerPOST(request: Request) {
  try {
    const body = await request.json();
    const question = typeof body.question === "string" ? body.question.trim() : "";
    const projectFiles = parseProjectFiles(body.projectFiles);
    let imageDataLength = 0;
    const currentImages = parseImages(body.images, imageDataLength);
    imageDataLength = currentImages.total;
    if ((!question && !currentImages.images.length) || question.length > 500) return NextResponse.json({ error: "请输入问题或添加图片；问题最多 500 个字符。" }, { status: 400 });
    const history: Array<{ role: "user" | "assistant"; content: string; images?: AgentImageInput[] }> = [];
    let historyCharacters = 0;
    if (Array.isArray(body.history)) {
      for (const item of body.history.slice(-12).reverse()) {
        if (!item || (item.role !== "user" && item.role !== "assistant") || typeof item.content !== "string") continue;
        const content = item.content.slice(0, 8000);
        const remaining = 16000 - historyCharacters;
        if (remaining <= 0) break;
        const messageImages = item.role === "user" ? parseImages(item.images, imageDataLength) : { images: [], total: imageDataLength };
        imageDataLength = messageImages.total;
        history.unshift({ role: item.role, content: content.slice(-remaining), ...(messageImages.images.length ? { images: messageImages.images } : {}) });
        historyCharacters += Math.min(content.length, remaining);
      }
    }
    const store = await getModelStore();
    const requestedId = typeof body.modelId === "string" ? body.modelId : store.defaultModelId;
    const model = requestedId ? await findModel(requestedId) : null;
    if (requestedId && !model) return NextResponse.json({ error: "所选模型配置不存在，请重新选择模型。" }, { status: 400 });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (value: unknown) => controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
        void answerQuestion(question, model, (token) => send({ type: "token", token }), history, currentImages.images, projectFiles)
          .then((result) => { send({ type: "done", result }); controller.close(); })
          .catch((error) => {
            console.error("Chat stream failed", error);
            send({ type: "error", error: chatErrorMessage(error) });
            controller.close();
          });
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
  } catch (error) {
    console.error("Chat query failed", error);
    return NextResponse.json({ error: chatErrorMessage(error) }, { status: 500 });
  }
}
export const POST = authenticated(handlerPOST);
