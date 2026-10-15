import { randomUUID } from "node:crypto";
import { migrateLegacyConfigs, readExternalMcpConfig, writeExternalMcpConfig } from "@/lib/local-db";

export type McpTransport = "http" | "stdio";
export type ExternalMcpServer = { id: string; name: string; transport: McpTransport; url: string; token: string; command: string; args: string[]; env: Record<string, string>; cwd: string; enabled: boolean; disabledTools: string[]; allowedTools: string[] };
type Store = { servers: ExternalMcpServer[] };

export function isDesktopMcpRuntime() { return process.env.LITTLE_SUNSHINE_RUNTIME === "desktop"; }

async function readStore(): Promise<Store> {
  await migrateLegacyConfigs();
  return await readExternalMcpConfig();
}

async function writeStore(store: Store) {
  await migrateLegacyConfigs();
  await writeExternalMcpConfig(store);
}

function normalizeServer(input: { name?: unknown; transport?: unknown; url?: unknown; token?: unknown; command?: unknown; args?: unknown; env?: unknown; cwd?: unknown }, existing?: ExternalMcpServer): ExternalMcpServer {
  const name = typeof input.name === "string" ? input.name.trim() : existing?.name || "";
  if (input.transport !== undefined && input.transport !== "stdio" && input.transport !== "http") throw new Error("MCP 传输类型无效。");
  const transport = input.transport === "stdio" || input.transport === "http" ? input.transport : existing?.transport || "http";
  if (transport === "stdio") {
    if (!isDesktopMcpRuntime()) throw new Error("本地命令 MCP 只能在 Desktop 版中配置和运行。");
    const command = typeof input.command === "string" ? input.command.trim() : existing?.command || "";
    if (!command || command.length > 2048 || command.includes("\0")) throw new Error("请填写有效的本地 MCP 启动命令。");
    if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some((value) => typeof value !== "string"))) throw new Error("本地 MCP 参数必须是字符串数组。");
    const args = Array.isArray(input.args) ? input.args as string[] : existing?.args || [];
    if (args.length > 64 || args.some((value) => value.length > 4096 || value.includes("\0"))) throw new Error("本地 MCP 参数无效或过多。");
    if (input.env !== undefined && (!input.env || typeof input.env !== "object" || Array.isArray(input.env))) throw new Error("本地 MCP 环境变量必须是 JSON 对象。");
    const rawEnv = input.env && typeof input.env === "object" && !Array.isArray(input.env) ? input.env as Record<string, unknown> : existing?.env || {};
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawEnv)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.length > 8192 || value.includes("\0")) throw new Error("本地 MCP 环境变量格式不正确。");
      env[key] = value;
    }
    const cwd = typeof input.cwd === "string" ? input.cwd.trim() : existing?.cwd || "";
    if (cwd.includes("\0")) throw new Error("工作目录格式不正确。");
    if (!name) throw new Error("请填写 MCP 名称。");
    return { id: existing?.id || randomUUID(), name, transport, url: "", token: "", command, args, env, cwd, enabled: existing?.enabled ?? true, disabledTools: existing?.disabledTools || [], allowedTools: existing?.allowedTools || [] };
  }
  const rawUrl = typeof input.url === "string" ? input.url.trim() : existing?.url || "";
  const token = typeof input.token === "string" && input.token.trim() ? input.token.trim() : existing?.token || "";
  if (!name) throw new Error("请填写 MCP 名称。");
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { throw new Error("MCP 地址格式不正确。"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("MCP 地址必须使用 HTTP 或 HTTPS。");
  if (parsed.username || parsed.password) throw new Error("请将认证信息填入访问令牌，而不是 URL。");
  return { id: existing?.id || randomUUID(), name, transport, url: parsed.toString(), token, command: "", args: [], env: {}, cwd: "", enabled: existing?.enabled ?? true, disabledTools: existing?.disabledTools || [], allowedTools: existing?.allowedTools || [] };
}

export async function listExternalMcpServers() {
  return (await readStore()).servers;
}

export async function saveExternalMcpServer(input: { id?: unknown; name?: unknown; transport?: unknown; url?: unknown; token?: unknown; command?: unknown; args?: unknown; env?: unknown; cwd?: unknown }) {
  const store = await readStore();
  const existing = typeof input.id === "string" ? store.servers.find((item) => item.id === input.id) : undefined;
  const next = normalizeServer(input, existing);
  store.servers = existing ? store.servers.map((item) => item.id === existing.id ? next : item) : [...store.servers, next];
  await writeStore(store);
  return next;
}

export async function updateExternalMcpServer(id: string, update: { enabled?: boolean; toolName?: string; toolEnabled?: boolean; manuallyAllowTool?: boolean }) {
  const store = await readStore();
  const server = store.servers.find((item) => item.id === id);
  if (!server) throw new Error("未找到外部 MCP 配置。");
  if (typeof update.enabled === "boolean") server.enabled = update.enabled;
  if (typeof update.toolName === "string" && typeof update.toolEnabled === "boolean") {
    if (update.toolEnabled) {
      server.disabledTools = server.disabledTools.filter((name) => name !== update.toolName);
      if (update.manuallyAllowTool && !server.allowedTools.includes(update.toolName)) server.allowedTools.push(update.toolName);
    }
    else if (!server.disabledTools.includes(update.toolName)) server.disabledTools.push(update.toolName);
    if (!update.toolEnabled && update.manuallyAllowTool) server.allowedTools = server.allowedTools.filter((name) => name !== update.toolName);
  }
  await writeStore(store);
  return server;
}

export async function removeExternalMcpServer(id: string) {
  const store = await readStore();
  store.servers = store.servers.filter((item) => item.id !== id);
  await writeStore(store);
}
