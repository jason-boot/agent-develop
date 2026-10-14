import { randomUUID } from "node:crypto";
import { migrateLegacyConfigs, readExternalMcpConfig, writeExternalMcpConfig } from "@/lib/local-db";

export type ExternalMcpServer = { id: string; name: string; url: string; token: string; enabled: boolean; disabledTools: string[]; allowedTools: string[] };
type Store = { servers: ExternalMcpServer[] };

async function readStore(): Promise<Store> {
  await migrateLegacyConfigs();
  return await readExternalMcpConfig();
}

async function writeStore(store: Store) {
  await migrateLegacyConfigs();
  await writeExternalMcpConfig(store);
}

function normalizeServer(input: { name?: unknown; url?: unknown; token?: unknown }, existing?: ExternalMcpServer): ExternalMcpServer {
  const name = typeof input.name === "string" ? input.name.trim() : existing?.name || "";
  const rawUrl = typeof input.url === "string" ? input.url.trim() : existing?.url || "";
  const token = typeof input.token === "string" && input.token.trim() ? input.token.trim() : existing?.token || "";
  if (!name) throw new Error("请填写 MCP 名称。");
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { throw new Error("MCP 地址格式不正确。"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("MCP 地址必须使用 HTTP 或 HTTPS。");
  if (parsed.username || parsed.password) throw new Error("请将认证信息填入访问令牌，而不是 URL。");
  return { id: existing?.id || randomUUID(), name, url: parsed.toString(), token, enabled: existing?.enabled ?? true, disabledTools: existing?.disabledTools || [], allowedTools: existing?.allowedTools || [] };
}

export async function listExternalMcpServers() {
  return (await readStore()).servers;
}

export async function saveExternalMcpServer(input: { id?: unknown; name?: unknown; url?: unknown; token?: unknown }) {
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
