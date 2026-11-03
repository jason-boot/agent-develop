import { randomUUID } from "node:crypto";
import { claimDueVideoGenerationTasks, getVideoGenerationTasksForConversation, readUserAppSetting, saveVideoGenerationTask, updateVideoGenerationTask, writeUserAppSetting, type StoredVideoGenerationTask } from "@/lib/local-db";
import { ModelServiceError, type AgentToolDefinition } from "@/lib/model-config";

const settingKey = "video_generation_mcp_config";
const videoTaskPollIntervalMs = 120_000;
export type BailianVideoRegion = "beijing" | "singapore" | "tokyo" | "frankfurt" | "virginia" | "hong-kong";
type VideoGenerationConfig = {
  enabled: boolean;
  region: BailianVideoRegion;
  workspaceId: string;
  model: "wan3.0-video" | "wan3.0-video-prime";
  apiKey: string;
  resolution: "480P" | "720P" | "1080P";
  duration: number;
};
export type PublicVideoGenerationConfig = Omit<VideoGenerationConfig, "apiKey"> & { provider: "aliyun-bailian"; hasApiKey: boolean; baseUrl: string };
export type PublicVideoGenerationTask = { id: string; conversationId: string; status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED"; videoUrl?: string; error?: string; model: string; provider: "阿里云百炼"; resolution: string; duration: number; createdAt: number; updatedAt: number };

const regionHosts: Record<BailianVideoRegion, string> = {
  beijing: "cn-beijing.maas.aliyuncs.com",
  singapore: "ap-southeast-1.maas.aliyuncs.com",
  tokyo: "ap-northeast-1.maas.aliyuncs.com",
  frankfurt: "eu-central-1.maas.aliyuncs.com",
  virginia: "us-east-1.maas.aliyuncs.com",
  "hong-kong": "cn-hongkong.maas.aliyuncs.com",
};

function baseUrl(region: BailianVideoRegion, workspaceId: string) {
  const workspace = workspaceId.trim();
  return workspace ? `https://${workspace}.${regionHosts[region]}` : "";
}

const defaults: VideoGenerationConfig = { enabled: false, region: "beijing", workspaceId: "", model: "wan3.0-video", apiKey: "", resolution: "720P", duration: 5 };

async function readConfig(): Promise<VideoGenerationConfig> {
  const value = await readUserAppSetting(settingKey);
  if (!value) return { ...defaults };
  try {
    const parsed = JSON.parse(value) as Partial<VideoGenerationConfig>;
    const region = Object.hasOwn(regionHosts, parsed.region || "") ? parsed.region as BailianVideoRegion : defaults.region;
    return {
      enabled: Boolean(parsed.enabled),
      region,
      workspaceId: typeof parsed.workspaceId === "string" ? parsed.workspaceId : "",
      model: parsed.model === "wan3.0-video-prime" ? parsed.model : "wan3.0-video",
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      resolution: parsed.resolution === "480P" || parsed.resolution === "1080P" ? parsed.resolution : "720P",
      duration: typeof parsed.duration === "number" && Number.isInteger(parsed.duration) && parsed.duration >= 2 && parsed.duration <= 30 ? parsed.duration : defaults.duration,
    };
  } catch { return { ...defaults }; }
}

export async function getPublicVideoGenerationConfig(): Promise<PublicVideoGenerationConfig> {
  const config = await readConfig();
  const { apiKey, ...safe } = config;
  return { ...safe, provider: "aliyun-bailian", hasApiKey: Boolean(apiKey), baseUrl: baseUrl(config.region, config.workspaceId) };
}

export async function getVideoGenerationConfig(): Promise<VideoGenerationConfig | null> {
  const config = await readConfig();
  return config.enabled && config.apiKey && config.workspaceId ? config : null;
}

export async function saveVideoGenerationConfig(input: {
  enabled?: boolean;
  region?: BailianVideoRegion;
  workspaceId?: string;
  model?: string;
  apiKey?: string;
  resolution?: string;
  duration?: number;
}) {
  const previous = await readConfig();
  if (input.enabled === false) {
    await writeUserAppSetting(settingKey, JSON.stringify({ ...previous, enabled: false }));
    return getPublicVideoGenerationConfig();
  }
  const region = input.region && Object.hasOwn(regionHosts, input.region) ? input.region : previous.region;
  const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : previous.workspaceId;
  const model = input.model === "wan3.0-video-prime" ? input.model : input.model === "wan3.0-video" ? input.model : previous.model;
  const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : previous.apiKey;
  const resolution = input.resolution === "480P" || input.resolution === "1080P" ? input.resolution : input.resolution === "720P" ? input.resolution : previous.resolution;
  const duration = typeof input.duration === "number" && Number.isInteger(input.duration) && input.duration >= 2 && input.duration <= 30 ? input.duration : previous.duration;
  if (!workspaceId || !apiKey) throw new Error("请填写 Workspace ID 和百炼 API Key。");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) throw new Error("Workspace ID 格式不正确。");
  await writeUserAppSetting(settingKey, JSON.stringify({ enabled: true, region, workspaceId, model, apiKey, resolution, duration } satisfies VideoGenerationConfig));
  return getPublicVideoGenerationConfig();
}

export const videoGenerationMcpTool: AgentToolDefinition = {
  name: "generate_video",
  description: "根据用户明确提出的视频生成或视频编辑请求生成视频。使用阿里云百炼 wan3.0-video 模型。prompt 应描述主体、动作、场景、镜头和风格。当前工具支持文生视频。",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", minLength: 1, maxLength: 4000, description: "视频内容、动作、场景、镜头和风格描述" },
      duration: { type: "integer", minimum: 2, maximum: 30, description: "视频时长秒数，可选" },
      resolution: { type: "string", enum: ["480P", "720P", "1080P"], description: "视频分辨率，可选" },
      ratio: { type: "string", enum: ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], description: "画面宽高比，可选" },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

async function readJson(response: Response) {
  return await response.json().catch(() => null) as Record<string, unknown> | null;
}

export async function createVideoGenerationTask(args: Record<string, unknown>, conversationId: string) {
  const config = await getVideoGenerationConfig();
  if (!config) throw new ModelServiceError("视频生成工具尚未启用或配置不完整。");
  if (!conversationId || conversationId.length > 128) throw new ModelServiceError("无法将视频任务关联到当前会话，请重试。");
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt || prompt.length > 4000) throw new ModelServiceError("视频提示词不能为空，且不能超过 4000 个字符。");
  const resolution = args.resolution === "480P" || args.resolution === "1080P" ? args.resolution : args.resolution === "720P" ? args.resolution : config.resolution;
  const duration = typeof args.duration === "number" && Number.isInteger(args.duration) && args.duration >= 2 && args.duration <= 30 ? args.duration : config.duration;
  const ratioOptions = ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
  const ratio = typeof args.ratio === "string" && ratioOptions.includes(args.ratio) ? args.ratio : "adaptive";
  const endpoint = baseUrl(config.region, config.workspaceId);
  let createResponse: Response;
  try {
    createResponse = await fetch(`${endpoint}/api/v1/services/aigc/video-generation/video-synthesis`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}`, "X-DashScope-Async": "enable" },
      body: JSON.stringify({ model: config.model, input: { prompt }, parameters: { resolution, ratio, duration, prompt_extend: true } }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new ModelServiceError(`无法连接阿里云百炼视频服务：${error instanceof Error ? error.message : "网络错误"}`);
  }
  const created = await readJson(createResponse);
  const createdOutput = created?.output as Record<string, unknown> | undefined;
  const taskId = typeof createdOutput?.task_id === "string" ? createdOutput.task_id : "";
  if (!createResponse.ok || !taskId) {
    const detail = typeof created?.message === "string" ? created.message : typeof createdOutput?.message === "string" ? createdOutput.message : "请检查百炼地域、模型和 API Key。";
    throw new ModelServiceError(`阿里云百炼未能创建视频任务（HTTP ${createResponse.status}）：${detail}`);
  }
  const id = randomUUID();
  await saveVideoGenerationTask({
    id, conversationId, providerTaskId: taskId, endpoint, apiKey: config.apiKey, model: config.model,
    resolution, duration, status: "PENDING", videoUrl: null, error: null, nextPollAt: Date.now() + videoTaskPollIntervalMs,
  });
  ensureVideoGenerationTaskPoller();
  return { id, providerTaskId: taskId, model: config.model, provider: "阿里云百炼" as const, duration, resolution, status: "PENDING" as const };
}

function publicTask(task: StoredVideoGenerationTask): PublicVideoGenerationTask {
  return {
    id: task.id,
    conversationId: task.conversationId,
    status: task.status === "SUCCEEDED" ? "SUCCEEDED" : task.status === "FAILED" ? "FAILED" : task.status === "RUNNING" ? "RUNNING" : "PENDING",
    ...(task.videoUrl ? { videoUrl: task.videoUrl } : {}),
    ...(task.error && task.status === "FAILED" ? { error: task.error } : {}),
    model: task.model,
    provider: "阿里云百炼",
    resolution: task.resolution,
    duration: task.duration,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export async function listVideoGenerationTasks(conversationId: string) {
  if (!conversationId || conversationId.length > 128) throw new ModelServiceError("会话 ID 无效。");
  return (await getVideoGenerationTasksForConversation(conversationId)).map(publicTask);
}

async function pollVideoTask(task: StoredVideoGenerationTask) {
  try {
    const response = await fetch(`${task.endpoint}/api/v1/tasks/${encodeURIComponent(task.providerTaskId)}`, {
      headers: { Authorization: `Bearer ${task.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    const data = await readJson(response);
    if (!response.ok) {
      // Retriable service/network errors keep the durable task pending. Authentication
      // and not-found responses are terminal because retrying cannot repair them.
      const terminal = response.status === 401 || response.status === 403 || response.status === 404;
      await updateVideoGenerationTask({ id: task.id, status: terminal ? "FAILED" : task.status, error: terminal ? `查询百炼任务返回 HTTP ${response.status}。` : null, nextPollAt: Date.now() + (terminal ? 60_000 : videoTaskPollIntervalMs), incrementPollAttempts: true, clearApiKey: terminal });
      return;
    }
    const output = data?.output as Record<string, unknown> | undefined;
    const providerStatus = typeof output?.task_status === "string" ? output.task_status.toUpperCase() : "";
    if (providerStatus === "SUCCEEDED" && typeof output?.video_url === "string") {
      await updateVideoGenerationTask({ id: task.id, status: "SUCCEEDED", videoUrl: output.video_url, nextPollAt: Date.now(), incrementPollAttempts: true, clearApiKey: true });
    } else if (["FAILED", "CANCELED", "CANCELLED", "UNKNOWN"].includes(providerStatus)) {
      const detail = typeof output?.message === "string" ? output.message : typeof data?.message === "string" ? data.message : providerStatus;
      const label = providerStatus === "FAILED" ? "失败" : providerStatus === "UNKNOWN" ? "已失效" : "已取消";
      await updateVideoGenerationTask({ id: task.id, status: "FAILED", error: `阿里云百炼视频任务${label}：${detail}`, nextPollAt: Date.now(), incrementPollAttempts: true, clearApiKey: true });
    } else {
      await updateVideoGenerationTask({ id: task.id, status: providerStatus === "RUNNING" ? "RUNNING" : "PENDING", nextPollAt: Date.now() + videoTaskPollIntervalMs, incrementPollAttempts: true });
    }
  } catch (error) {
    console.error("Video generation task polling failed", task.id, error instanceof Error ? error.message : "unknown error");
    await updateVideoGenerationTask({ id: task.id, status: task.status, nextPollAt: Date.now() + videoTaskPollIntervalMs, incrementPollAttempts: true }).catch(() => undefined);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var dqVideoGenerationPoller: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var dqVideoGenerationPolling: boolean | undefined;
  // eslint-disable-next-line no-var
  var dqVideoGenerationPollerIntervalMs: number | undefined;
}

export function ensureVideoGenerationTaskPoller() {
  if (!global.dqVideoGenerationPoller || global.dqVideoGenerationPollerIntervalMs !== videoTaskPollIntervalMs) {
    if (global.dqVideoGenerationPoller) clearInterval(global.dqVideoGenerationPoller);
    global.dqVideoGenerationPoller = setInterval(() => { void runVideoGenerationPollCycle(); }, videoTaskPollIntervalMs);
    global.dqVideoGenerationPollerIntervalMs = videoTaskPollIntervalMs;
    global.dqVideoGenerationPoller.unref?.();
  }
  void runVideoGenerationPollCycle();
}

async function runVideoGenerationPollCycle() {
  if (global.dqVideoGenerationPolling) return;
  global.dqVideoGenerationPolling = true;
  try {
    const now = Date.now();
    const tasks = await claimDueVideoGenerationTasks(now, now + 60_000);
    await Promise.all(tasks.map((task) => pollVideoTask(task)));
  } catch (error) {
    console.error("Video generation task poll cycle failed", error instanceof Error ? error.message : "unknown error");
  } finally { global.dqVideoGenerationPolling = false; }
}

ensureVideoGenerationTaskPoller();
