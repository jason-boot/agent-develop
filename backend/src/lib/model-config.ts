import { randomUUID } from "node:crypto";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { migrateLegacyConfigs, readModelConfigStore, writeModelConfigStore } from "@/lib/local-db";

const hasOutboundProxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
if (hasOutboundProxy) setGlobalDispatcher(new EnvHttpProxyAgent());

export type ModelConfig = {
  id: string;
  name: string;
  protocol: "chat" | "messages" | "responses";
  baseUrl: string;
  fullAddress: boolean;
  model: string;
  apiKey: string;
  vendor: string;
  modelsUrl: string;
};

export class ModelServiceError extends Error {}

function fetchFailureMessage(error: unknown) {
  let cause: unknown = error;
  let code = "";
  for (let depth = 0; depth < 5 && cause && typeof cause === "object"; depth += 1) {
    const details = cause as { code?: unknown; cause?: unknown };
    if (typeof details.code === "string" && /^[A-Z0-9_]+$/.test(details.code)) { code = details.code; break; }
    cause = details.cause;
  }
  return `无法连接模型服务${code ? `（${code}）` : ""}，请检查 API 地址和服务端网络。`;
}

type ModelStore = { models: ModelConfig[]; defaultModelId: string | null };

async function readStore(): Promise<ModelStore> {
  await migrateLegacyConfigs();
  const store = await readModelConfigStore();
  return { models: store.models as ModelConfig[], defaultModelId: store.defaultModelId };
}

async function writeStore(store: ModelStore) {
  await migrateLegacyConfigs();
  await writeModelConfigStore(store);
}

export async function getModelStore() {
  return readStore();
}

export async function listPublicModels() {
  const store = await readStore();
  return {
    models: store.models.map(({ apiKey, ...model }) => ({ ...model, hasApiKey: Boolean(apiKey) })),
    defaultModelId: store.defaultModelId,
  };
}

export async function findModel(id: string) {
  const store = await readStore();
  return store.models.find((model) => model.id === id) || null;
}

export async function findLatestProviderConfig(vendor: string) {
  const store = await readStore();
  let model = [...store.models].reverse().find((item) => item.vendor === vendor);
  if (!model && vendor === "aliyun-bailian") {
    model = [...store.models].reverse().find((item) => {
      if (item.vendor !== "custom") return false;
      try { const hostname = new URL(item.baseUrl).hostname; return hostname.endsWith(".maas.aliyuncs.com") || hostname.endsWith(".dashscope.aliyuncs.com"); }
      catch { return false; }
    });
    if (model) {
      const hostname = new URL(model.baseUrl).hostname;
      model.vendor = "aliyun-bailian";
      if (!model.modelsUrl) model.modelsUrl = `https://${hostname}/api/v1/models`;
      await writeStore(store);
    }
  }
  if (!model) return null;
  return { id: model.id, vendor: model.vendor, protocol: model.protocol, baseUrl: model.baseUrl, fullAddress: model.fullAddress, modelsUrl: model.modelsUrl, hasApiKey: Boolean(model.apiKey) };
}

export async function saveModel(input: Partial<ModelConfig>) {
  const store = await readStore();
  const existing = input.id ? store.models.find((model) => model.id === input.id) : undefined;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const protocol = input.protocol || existing?.protocol || "chat";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const fullAddress = typeof input.fullAddress === "boolean" ? input.fullAddress : existing?.fullAddress || false;
  const rawBaseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  const baseUrl = fullAddress ? rawBaseUrl : rawBaseUrl.replace(/\/+$/, "");
  const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : existing?.apiKey || "";
  if (!name || !model || !baseUrl || !apiKey) throw new Error("请填写模型名称、API 地址、模型 ID 和 API Key。");
  if (protocol !== "chat" && protocol !== "messages" && protocol !== "responses") throw new Error("请选择支持的 API 协议。");
  let parsedUrl: URL;
  try { parsedUrl = new URL(baseUrl); } catch { throw new Error("API 地址格式不正确。"); }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") throw new Error("API 地址必须使用 HTTP 或 HTTPS。");
  const vendor = typeof input.vendor === "string" ? input.vendor : existing?.vendor || "custom";
  const modelsUrl = typeof input.modelsUrl === "string" ? input.modelsUrl.trim() : existing?.modelsUrl || "";
  const next: ModelConfig = { id: existing?.id || randomUUID(), name, protocol, baseUrl, fullAddress, model, apiKey, vendor, modelsUrl };
  store.models = existing ? store.models.map((item) => item.id === existing.id ? next : item) : [...store.models, next];
  if (!store.defaultModelId) store.defaultModelId = next.id;
  await writeStore(store);
  return listPublicModels();
}

export async function discoverProviderModels(input: { vendor?: string; modelsUrl: string; apiKey: string; credentialSourceModelId?: string }) {
  const rawUrl = input.modelsUrl.trim();
  const store = await readStore();
  const source = input.credentialSourceModelId ? store.models.find((model) => model.id === input.credentialSourceModelId && model.vendor === input.vendor) : undefined;
  const apiKey = input.apiKey.trim() || source?.apiKey || "";
  if (!rawUrl || !apiKey) throw new Error("请先填写 API Key，或复用该厂商已保存的配置。");
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("API 地址格式不正确。"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("API 地址必须使用 HTTP 或 HTTPS。");
  const endpoint = url.toString();
  const headers = { Authorization: "Bearer " + apiKey };
  if (input.vendor === "aliyun-bailian") {
    const models: string[] = [];
    let total = Number.POSITIVE_INFINITY;
    for (let page = 1; page <= 20 && models.length < total; page += 1) {
      const pageUrl = new URL(endpoint);
      pageUrl.searchParams.set("page_no", String(page));
      pageUrl.searchParams.set("page_size", "100");
      let pageResponse: Response;
      try { pageResponse = await fetch(pageUrl, { headers, signal: AbortSignal.timeout(15000) }); }
      catch { throw new Error("无法连接阿里云百炼模型目录，请检查地域、业务空间 ID 和网络。"); }
      if (!pageResponse.ok) throw new Error(`阿里云百炼返回 HTTP ${pageResponse.status}，无法读取模型列表。`);
      let pagePayload: unknown;
      try { pagePayload = await pageResponse.json(); } catch { throw new Error("阿里云百炼返回的模型目录格式无法识别。"); }
      const output = (pagePayload as { output?: { total?: unknown; models?: unknown } }).output;
      if (!output || !Array.isArray(output.models)) throw new Error("阿里云百炼未返回 output.models 模型列表。");
      if (typeof output.total === "number") total = output.total;
      for (const item of output.models) {
        if (item && typeof item === "object" && typeof (item as { model?: unknown }).model === "string") models.push((item as { model: string }).model.trim());
      }
      if (!output.models.length) break;
    }
    const uniqueModels = [...new Set(models.filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (!uniqueModels.length) throw new Error("阿里云百炼模型目录为空。");
    return uniqueModels;
  }
  let response: Response;
  try { response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error("无法连接模型服务，请检查 API 地址和网络。"); }
  if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}，无法读取模型列表。`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("模型服务返回的目录格式无法识别。"); }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error("该服务未返回兼容的模型目录，请改用手动添加。");
  const models = data.map((item) => {
    if (typeof item === "string") return item.trim();
    if (!item || typeof item !== "object") return "";
    const entry = item as { id?: unknown; name?: unknown };
    return typeof entry.id === "string" ? entry.id.trim() : typeof entry.name === "string" ? entry.name.trim() : "";
  }).filter(Boolean);
  if (!models.length) throw new Error("模型目录为空，请改用手动添加。");
  return [...new Set(models)].sort((a, b) => a.localeCompare(b));
}

export async function saveModelsBatch(input: { protocol: ModelConfig["protocol"]; baseUrl: string; fullAddress?: boolean; apiKey: string; name: string; vendor?: string; modelsUrl?: string; credentialSourceModelId?: string; models: Array<{ name: string; model: string }> }) {
  const store = await readStore();
  const { protocol } = input;
  const name = input.name.trim();
  const rawBaseUrl = input.baseUrl.trim();
  const baseUrl = input.fullAddress ? rawBaseUrl : rawBaseUrl.replace(/\/+$/, "");
  const source = input.credentialSourceModelId ? store.models.find((model) => model.id === input.credentialSourceModelId && model.vendor === input.vendor) : undefined;
  const apiKey = input.apiKey.trim() || source?.apiKey || "";
  const models = input.models.map((entry) => ({ name: entry.name.trim(), model: entry.model.trim() })).filter((entry) => entry.name && entry.model);
  if (!name || !baseUrl || !apiKey || !models.length) throw new Error("请填写厂商名称、API 地址、API Key，并至少填写一行模型展示名称和上游模型名。");
  if (protocol !== "chat" && protocol !== "messages" && protocol !== "responses") throw new Error("请选择支持的 API 协议。");
  let parsedUrl: URL;
  try { parsedUrl = new URL(baseUrl); } catch { throw new Error("API 地址格式不正确。"); }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") throw new Error("API 地址必须使用 HTTP 或 HTTPS。");
  for (const entry of models) {
    const existing = store.models.find((item) => item.protocol === protocol && item.baseUrl === baseUrl && item.model === entry.model);
    const next: ModelConfig = { id: existing?.id || randomUUID(), name: entry.name, protocol, baseUrl, fullAddress: Boolean(input.fullAddress), model: entry.model, apiKey, vendor: input.vendor || "custom", modelsUrl: input.modelsUrl?.trim() || "" };
    if (existing) store.models = store.models.map((item) => item.id === existing.id ? next : item);
    else store.models.push(next);
    if (!store.defaultModelId) store.defaultModelId = next.id;
  }
  await writeStore(store);
  return listPublicModels();
}

export async function removeModel(id: string) {
  const store = await readStore();
  store.models = store.models.filter((model) => model.id !== id);
  if (store.defaultModelId === id) store.defaultModelId = store.models[0]?.id || null;
  await writeStore(store);
  return listPublicModels();
}

export async function setDefaultModel(id: string | null) {
  const store = await readStore();
  if (id && !store.models.some((model) => model.id === id)) throw new Error("找不到所选模型。");
  store.defaultModelId = id;
  await writeStore(store);
  return listPublicModels();
}

function protocolUrl(baseUrl: string, protocol: ModelConfig["protocol"]) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (protocol === "chat") return /\/v1$/i.test(trimmed) ? trimmed + "/chat/completions" : trimmed + "/v1/chat/completions";
  if (protocol === "messages") {
    return /\/v1$/i.test(trimmed) ? trimmed + "/messages" : trimmed + "/v1/messages";
  }
  return /\/v1$/i.test(trimmed) ? trimmed + "/responses" : trimmed + "/v1/responses";
}

export async function requestModelCompletion(config: ModelConfig, messages: Array<{ role: string; content: string }>, maxTokens = 500) {
  let response: Response;
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const conversation = messages.filter((message) => message.role !== "system");
  let headers: Record<string, string> = { "Content-Type": "application/json" };
  let body: Record<string, unknown>;
  if (config.protocol === "messages") {
    headers = { ...headers, "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" };
    body = { model: config.model, max_tokens: maxTokens, stream: false, ...(system ? { system } : {}), messages: conversation };
  } else if (config.protocol === "responses") {
    headers = { ...headers, Authorization: "Bearer " + config.apiKey };
    body = { model: config.model, ...(system ? { instructions: system } : {}), input: conversation.map((message) => ({ role: message.role, content: message.content })), max_output_tokens: maxTokens, stream: false, store: false };
  } else {
    headers = { ...headers, Authorization: "Bearer " + config.apiKey };
    body = { model: config.model, messages, temperature: 0.2, max_tokens: maxTokens, stream: false };
  }
  try {
    response = await fetch(config.fullAddress ? config.baseUrl : protocolUrl(config.baseUrl, config.protocol), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new ModelServiceError(fetchFailureMessage(error));
  }
  if (!response.ok) throw new ModelServiceError("模型服务返回 HTTP " + response.status + "，请检查模型名称、API 地址和 API Key。");
  let payload: Record<string, unknown>;
  try { payload = await response.json() as Record<string, unknown>; }
  catch { throw new ModelServiceError("模型服务响应格式无法识别，请检查所选协议是否正确。"); }
  let content = "";
  if (config.protocol === "messages") {
    const blocks = payload.content;
    if (Array.isArray(blocks)) content = blocks.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text").map((block) => String((block as { text?: string }).text || "")).join("");
  } else if (config.protocol === "responses") {
    if (typeof payload.output_text === "string") content = payload.output_text;
    else if (Array.isArray(payload.output)) content = payload.output.flatMap((item) => {
      if (!item || typeof item !== "object" || !Array.isArray((item as { content?: unknown }).content)) return [];
      return ((item as { content: Array<{ type?: string; text?: string }> }).content).filter((part) => part.type === "output_text" && typeof part.text === "string").map((part) => part.text as string);
    }).join("");
  } else {
    const choices = payload.choices as Array<{ message?: { content?: string | null } }> | undefined;
    content = choices?.[0]?.message?.content || "";
  }
  if (!content.trim()) throw new ModelServiceError("模型服务没有返回文本，请检查模型配置。");
  return content.trim();
}

export type AgentToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };
export type AgentToolCall = { id: string; name: string; arguments: Record<string, unknown>; argumentError?: string };
export type AgentImageInput = { mimeType: "image/jpeg" | "image/png" | "image/webp"; dataUrl: string };
export type AgentMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; images?: AgentImageInput[]; toolCalls?: AgentToolCall[]; toolCallId?: string };

function imageData(image: AgentImageInput) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
  if (!match || match[1] !== image.mimeType) throw new ModelServiceError("图片格式无效，请重新选择 JPG、PNG 或 WebP 图片。");
  return { mediaType: match[1], data: match[2] };
}

export async function requestModelAgentTurn(
  config: ModelConfig,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
  onToken: (token: string) => void,
): Promise<{ text: string; toolCalls: AgentToolCall[]; generatedImages: string[] }> {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const conversation = messages.filter((message) => message.role !== "system");
  let headers: Record<string, string> = { "Content-Type": "application/json" };
  let body: Record<string, unknown>;
  if (config.protocol === "messages") {
    headers = { ...headers, "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" };
    const apiMessages: Array<{ role: string; content: unknown }> = [];
    for (const message of conversation) {
      if (message.role === "tool") {
        const result = { type: "tool_result", tool_use_id: message.toolCallId, content: message.content };
        const last = apiMessages[apiMessages.length - 1];
        if (last?.role === "user" && Array.isArray(last.content)) (last.content as unknown[]).push(result);
        else apiMessages.push({ role: "user", content: [result] });
      } else if (message.role === "assistant" && message.toolCalls?.length) {
        apiMessages.push({ role: "assistant", content: [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...message.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })),
        ] });
      } else if (message.role === "user" && message.images?.length) {
        apiMessages.push({ role: message.role, content: [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...message.images.map((image) => { const source = imageData(image); return { type: "image", source: { type: "base64", media_type: source.mediaType, data: source.data } }; }),
        ] });
      } else apiMessages.push({ role: message.role, content: message.content });
    }
    body = {
      model: config.model, max_tokens: 900, stream: true, ...(system ? { system } : {}), messages: apiMessages,
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
    };
  } else if (config.protocol === "responses") {
    headers = { ...headers, Authorization: "Bearer " + config.apiKey };
    const input: Array<Record<string, unknown>> = [];
    for (const message of conversation) {
      if (message.role === "tool") input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
      else if (message.role === "assistant" && message.toolCalls?.length) {
        if (message.content) input.push({ role: "assistant", content: [{ type: "output_text", text: message.content }] });
        for (const call of message.toolCalls) input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
      } else if (message.role === "user" && message.images?.length) input.push({ role: message.role, content: [
        ...(message.content ? [{ type: "input_text", text: message.content }] : []),
        ...message.images.map((image) => ({ type: "input_image", image_url: image.dataUrl, detail: "auto" })),
      ] });
      else input.push({ role: message.role, content: message.content });
    }
    body = {
      model: config.model, ...(system ? { instructions: system } : {}), input,
      tools: [
        ...tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })),
        ...(config.model.toLowerCase().includes("gpt-5.6-luna") ? [{ type: "image_generation", model: "gpt-image-2.5-sunburst", action: "auto", output_format: "png" }] : []),
      ],
      stream: true, store: false, max_output_tokens: 900,
    };
  } else {
    headers = { ...headers, Authorization: "Bearer " + config.apiKey };
    const apiMessages = messages.map((message) => message.role === "assistant" && message.toolCalls?.length
      ? { role: "assistant", content: message.content || null, tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
      : message.role === "tool"
        ? { role: "tool", tool_call_id: message.toolCallId, content: message.content }
        : message.role === "user" && message.images?.length
          ? { role: message.role, content: [
            ...(message.content ? [{ type: "text", text: message.content }] : []),
            ...message.images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
          ] }
        : { role: message.role, content: message.content });
    body = {
      model: config.model, messages: apiMessages,
      tools: tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
      tool_choice: "auto", temperature: 0.2, max_tokens: 900, stream: true,
    };
  }

  let response: Response;
  try {
    response = await fetch(config.fullAddress ? config.baseUrl : protocolUrl(config.baseUrl, config.protocol), {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    throw new ModelServiceError(fetchFailureMessage(error));
  }
  if (!response.ok || !response.body) throw new ModelServiceError("模型服务返回 HTTP " + response.status + "，请检查模型名称、工具调用支持、API 地址和 API Key。");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  let fullText = "";
  const generatedImages: string[] = [];
  const calls = new Map<number, AgentToolCall & { rawArguments: string; directArguments?: unknown }>();
  const appendToolArguments = (call: AgentToolCall & { rawArguments: string; directArguments?: unknown }, value: unknown) => {
    if (typeof value === "string") call.rawArguments += value;
    else if (value && typeof value === "object") call.directArguments = value;
  };
  const appendToken = (token: string) => { if (token) { fullText += token; onToken(token); } };
  const dispatch = () => {
    if (!dataLines.length) { eventName = ""; return; }
    const data = dataLines.join("\n");
    dataLines = [];
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(data) as Record<string, unknown>; } catch { eventName = ""; return; }
    if (config.protocol === "messages") {
      if (eventName === "content_block_start") {
        const block = payload.content_block as Record<string, unknown> | undefined;
        if (block?.type === "tool_use") calls.set(Number(payload.index), { id: String(block.id || ""), name: String(block.name || ""), arguments: {}, rawArguments: "", directArguments: block.input });
      } else if (eventName === "content_block_delta") {
        const delta = payload.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta") appendToken(String(delta.text || ""));
        else if (delta?.type === "input_json_delta") {
          const call = calls.get(Number(payload.index)); if (call) appendToolArguments(call, delta.partial_json || "");
        }
      } else if (eventName === "error") throw new ModelServiceError("模型服务返回错误，请检查模型配置和 API Key。");
    } else if (config.protocol === "responses") {
      if (eventName === "response.output_text.delta") appendToken(String(payload.delta || ""));
      else if (eventName === "response.output_item.added") {
        const item = payload.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          const call = { id: String(item.call_id || item.id || ""), name: String(item.name || ""), arguments: {}, rawArguments: "", directArguments: undefined };
          appendToolArguments(call, item.arguments);
          calls.set(Number(payload.output_index), call);
        }
      } else if (eventName === "response.function_call_arguments.delta") {
        const call = calls.get(Number(payload.output_index)); if (call) appendToolArguments(call, payload.delta || "");
      } else if (eventName === "response.output_item.done") {
        const item = payload.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          const index = Number(payload.output_index);
          const call = calls.get(index) || { id: "", name: "", arguments: {}, rawArguments: "" };
          call.id = String(item.call_id || call.id || item.id || ""); call.name = String(item.name || call.name);
          if (typeof item.arguments === "string" && item.arguments) call.rawArguments = item.arguments;
          else if (item.arguments && typeof item.arguments === "object") call.directArguments = item.arguments;
          calls.set(index, call);
        } else if (item?.type === "image_generation_call" && typeof item.result === "string") {
          generatedImages.push(`data:image/png;base64,${item.result}`);
        }
      } else if (eventName === "response.completed") {
        const responsePayload = payload.response as Record<string, unknown> | undefined;
        if (Array.isArray(responsePayload?.output)) {
          for (const item of responsePayload.output as Array<Record<string, unknown>>) {
            if (item.type === "image_generation_call" && typeof item.result === "string" && !generatedImages.includes(`data:image/png;base64,${item.result}`)) {
              generatedImages.push(`data:image/png;base64,${item.result}`);
            }
          }
        }
      } else if (eventName === "error" || eventName === "response.failed") throw new ModelServiceError("模型服务返回错误，请检查模型配置和 API Key。");
    } else {
      if (payload.error) throw new ModelServiceError("模型服务返回错误，请检查模型配置和 API Key。");
      const choice = (payload.choices as Array<{ delta?: { content?: string | Array<{ text?: string }>; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> | undefined)?.[0];
      const content = choice?.delta?.content;
      appendToken(typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text || "").join("") : "");
      for (const part of choice?.delta?.tool_calls || []) {
        const index = Number(part.index || 0);
        const call = calls.get(index) || { id: "", name: "", arguments: {}, rawArguments: "" };
        call.id += part.id || "";
        call.name += part.function?.name || "";
        appendToolArguments(call, part.function?.arguments || "");
        calls.set(index, call);
      }
    }
    eventName = "";
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line) dispatch();
        else if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (done) break;
    }
    if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart());
    dispatch();
  } catch (error) {
    if (error instanceof ModelServiceError) throw error;
    throw new ModelServiceError("读取模型流式响应失败，请稍后重试。");
  } finally { reader.releaseLock(); }

  const toolCalls = [...calls.values()].map((call) => {
    let parsedArguments: unknown;
    let argumentError: string | undefined;
    try { parsedArguments = call.rawArguments.trim() ? JSON.parse(call.rawArguments) : call.directArguments ?? {}; }
    catch { parsedArguments = {}; argumentError = `工具 ${call.name || "未知"} 的参数不是有效 JSON，已请求模型重新生成。`; }
    if (!parsedArguments || typeof parsedArguments !== "object" || Array.isArray(parsedArguments)) {
      parsedArguments = {};
      argumentError = `工具 ${call.name || "未知"} 的参数必须是 JSON 对象，已请求模型重新生成。`;
    }
    return { id: call.id, name: call.name, arguments: parsedArguments as Record<string, unknown>, ...(argumentError ? { argumentError } : {}) };
  });
  if (!fullText.trim() && toolCalls.length === 0 && generatedImages.length === 0) throw new ModelServiceError("模型服务没有返回文本、图片或工具调用，请检查模型是否支持工具调用。");
  return { text: fullText, toolCalls, generatedImages };
}
