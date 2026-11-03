import { readUserAppSetting, writeUserAppSetting } from "@/lib/local-db";
import { getModelStore, requestImageGeneration, type ImageGenerationConfig, ModelServiceError } from "@/lib/model-config";
import type { AgentToolDefinition } from "@/lib/model-config";

const settingKey = "image_generation_mcp_config";
export type ImageGenerationProviderId = "agnes" | "openai" | "qwen";
export type ImageGenerationMcpConfig = { enabled: boolean; activeProvider: ImageGenerationProviderId | null; providers: Partial<Record<ImageGenerationProviderId, ImageGenerationConfig>> };
export type PublicImageGenerationProvider = Omit<ImageGenerationConfig, "apiKey"> & { hasApiKey: boolean };
export type PublicImageGenerationMcpConfig = { enabled: boolean; activeProvider: ImageGenerationProviderId | null; providers: Partial<Record<ImageGenerationProviderId, PublicImageGenerationProvider>> };

export const imageGenerationMcpTool: AgentToolDefinition = {
  name: "generate_image",
  description: "根据用户明确提出的图片生成或图片编辑请求生成图片。prompt 应完整描述图片主体、场景、风格、构图和关键细节。",
  inputSchema: {
    type: "object",
    properties: { prompt: { type: "string", minLength: 1, maxLength: 4000, description: "图片的完整生成提示词" } },
    required: ["prompt"],
    additionalProperties: false,
  },
};

function isQwenImageOpenAiBaseUrl(value: string) {
  try {
    const parsed = new URL(value);
    const supportedRegion = ["cn-beijing", "ap-southeast-1", "us-east-1", "eu-central-1", "ap-northeast-1"]
      .some((region) => parsed.hostname.endsWith(`.${region}.maas.aliyuncs.com`));
    return parsed.protocol === "https:" && supportedRegion && parsed.pathname.replace(/\/+$/, "") === "/compatible-mode/v1";
  } catch { return false; }
}

function providerIdFor(config: Pick<ImageGenerationConfig, "provider" | "baseUrl">): ImageGenerationProviderId {
  if (config.provider === "qwen-dashscope") return "qwen";
  try { if (new URL(config.baseUrl).hostname.includes("agnes")) return "agnes"; } catch { /* Use the OpenAI-compatible default. */ }
  return "openai";
}

function validProviderConfig(value: unknown, providerId: ImageGenerationProviderId): ImageGenerationConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const config = value as Partial<ImageGenerationConfig>;
  if (typeof config.baseUrl !== "string" || typeof config.model !== "string" || typeof config.apiKey !== "string" || !config.baseUrl || !config.model || !config.apiKey) return undefined;
  return {
    provider: config.provider === "qwen-dashscope" ? "qwen-dashscope" : "openai-images",
    baseUrl: config.baseUrl,
    fullAddress: Boolean(config.fullAddress),
    model: config.model,
    apiKey: config.apiKey,
    size: typeof config.size === "string" && config.size ? config.size : "1024x1024",
  };
}

async function readSettings(): Promise<ImageGenerationMcpConfig> {
  const value = await readUserAppSetting(settingKey);
  if (value) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (parsed.providers && typeof parsed.providers === "object") {
        const providers = parsed.providers as Record<string, unknown>;
        const clean: ImageGenerationMcpConfig["providers"] = {};
        for (const id of ["agnes", "openai", "qwen"] as const) {
          const config = validProviderConfig(providers[id], id);
          if (config) clean[id] = config;
        }
        const activeProvider = ["agnes", "openai", "qwen"].includes(String(parsed.activeProvider)) ? parsed.activeProvider as ImageGenerationProviderId : null;
        return { enabled: Boolean(parsed.enabled && activeProvider && clean[activeProvider]), activeProvider, providers: clean };
      }
      // Migrate the previous single-provider setting into its vendor category.
      const legacy = parsed as unknown as ImageGenerationConfig & { enabled?: boolean };
      if (legacy.provider && legacy.baseUrl && legacy.model && legacy.apiKey) {
        const id = providerIdFor(legacy);
        const config = validProviderConfig(legacy, id);
        return { enabled: Boolean(legacy.enabled && config), activeProvider: config ? id : null, providers: config ? { [id]: config } : {} };
      }
    } catch { /* Treat malformed stored settings as unconfigured. */ }
  }

  const modelStore = await getModelStore();
  const legacy = modelStore.models.find((model) => model.id === modelStore.defaultModelId && model.imageGeneration)?.imageGeneration
    || modelStore.models.find((model) => model.imageGeneration)?.imageGeneration;
  if (legacy) {
    const id = providerIdFor(legacy);
    return { enabled: true, activeProvider: id, providers: { [id]: legacy } };
  }
  return { enabled: false, activeProvider: null, providers: {} };
}

export async function getImageGenerationMcpConfig(): Promise<(ImageGenerationConfig & { enabled: boolean; providerId: ImageGenerationProviderId }) | null> {
  const settings = await readSettings();
  const provider = settings.activeProvider ? settings.providers[settings.activeProvider] : undefined;
  if (settings.activeProvider === "qwen" && provider && (provider.provider !== "openai-images" || !isQwenImageOpenAiBaseUrl(provider.baseUrl))) return null;
  return settings.enabled && provider && settings.activeProvider ? { ...provider, enabled: true, providerId: settings.activeProvider } : null;
}

export async function getPublicImageGenerationMcpConfig(): Promise<PublicImageGenerationMcpConfig> {
  const settings = await readSettings();
  const providers: PublicImageGenerationMcpConfig["providers"] = {};
  for (const id of ["agnes", "openai", "qwen"] as const) {
    const config = settings.providers[id];
    if (!config) continue;
    const { apiKey, ...safeConfig } = config;
    providers[id] = { ...safeConfig, hasApiKey: Boolean(apiKey) };
  }
  return { enabled: settings.enabled, activeProvider: settings.activeProvider, providers };
}

export async function saveImageGenerationMcpConfig(input: {
  providerId?: ImageGenerationProviderId;
  baseUrl?: string;
  fullAddress?: boolean;
  model?: string;
  apiKey?: string;
  size?: string;
  enabled?: boolean;
  activate?: boolean;
}) {
  const settings = await readSettings();
  if (input.enabled === false && !input.providerId) {
    settings.enabled = false;
    await writeUserAppSetting(settingKey, JSON.stringify(settings));
    return getPublicImageGenerationMcpConfig();
  }
  const providerId = input.providerId;
  if (!providerId || !["agnes", "openai", "qwen"].includes(providerId)) throw new Error("请选择图像生成服务商。");
  const existing = settings.providers[providerId];
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : existing?.baseUrl || "";
  const model = typeof input.model === "string" ? input.model.trim() : existing?.model || "";
  const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : existing?.apiKey || "";
  const fullAddress = typeof input.fullAddress === "boolean" ? input.fullAddress : existing?.fullAddress || false;
  const size = typeof input.size === "string" && input.size.trim() ? input.size.trim() : existing?.size?.replace("*", "x") || "1024x1024";
  if (!baseUrl || !model || !apiKey) throw new Error("请填写 API 地址、图像模型 ID 和 API Key。");
  if (providerId === "qwen" && !isQwenImageOpenAiBaseUrl(baseUrl)) throw new Error("千问图像生成需要选择支持的百炼地域并填写 Workspace ID，使用 OpenAI 兼容 API 地址。");
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new Error("图像 API 地址格式不正确。"); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("图像 API 地址必须使用 HTTP 或 HTTPS。");
  settings.providers[providerId] = { provider: "openai-images", baseUrl, fullAddress: providerId === "qwen" ? false : fullAddress, model, apiKey, size };
  if (input.activate !== false || !settings.activeProvider) {
    settings.activeProvider = providerId;
    settings.enabled = true;
  }
  await writeUserAppSetting(settingKey, JSON.stringify(settings));
  return getPublicImageGenerationMcpConfig();
}

export async function callImageGenerationMcpTool(args: Record<string, unknown>) {
  const config = await getImageGenerationMcpConfig();
  if (!config) throw new ModelServiceError("图像生成工具尚未启用或配置不完整。");
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt || prompt.length > 4000) throw new ModelServiceError("图像提示词不能为空，且不能超过 4000 个字符。");
  const images = await requestImageGeneration(config, prompt);
  return { images, count: images.length };
}
