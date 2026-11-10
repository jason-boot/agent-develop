import { authenticated } from "@/lib/auth";
import { callBrowserBridgeCommand, completeBrowserCall, createBrowserPairing, currentBrowserBridge, LATEST_BROWSER_BRIDGE_VERSION, nextBrowserCall, pairBrowser, persistBrowserBridgeSession, resumeBrowserBridge, updateBrowserBridgeState, type BrowserMcpStatus, type BrowserTool } from "@/lib/browser-bridge";
import { listExternalMcpServers, removeExternalMcpServer } from "@/lib/external-mcp-config";
import { readUserAppSetting, writeUserAppSetting } from "@/lib/local-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = authenticated(async () => {
  const bridge = currentBrowserBridge();
  const storedTimeout = Number(await readUserAppSetting("browser_bridge_call_timeout_seconds"));
  let hiddenMcpPluginIds: string[] = [];
  try {
    const hidden = JSON.parse((await readUserAppSetting("hidden_local_mcp_plugin_ids")) || "[]");
    if (Array.isArray(hidden)) hiddenMcpPluginIds = hidden.filter((id): id is string => typeof id === "string" && (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) || /^@[a-zA-Z0-9._~-]+\/[a-zA-Z0-9._~-]+$/.test(id)));
  } catch { /* Ignore malformed account-level hidden plugin settings. */ }
  const callTimeoutSeconds = Number.isInteger(storedTimeout) && storedTimeout >= 5 && storedTimeout <= 300 ? storedTimeout : 30;
  return Response.json({ connected: Boolean(bridge), tools: bridge?.tools || [], mcpServers: bridge?.mcpServers || [], hiddenMcpPluginIds, installDirectory: bridge?.installDirectory || "", bridgeVersion: bridge?.version || "", latestBridgeVersion: LATEST_BROWSER_BRIDGE_VERSION, callTimeoutSeconds });
});

function bridgeInstallDirectory(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) throw new Error("桥接程序安装目录无效。");
  return value;
}
function bridgeVersion(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error("桥接工具版本格式无效。");
  return value;
}

const createPairing = authenticated(async (_request: Request) => Response.json({ code: createBrowserPairing() }));
const saveCallTimeout = authenticated(async (request: Request) => {
  const body = await request.json() as Record<string, unknown>;
  const seconds = body.seconds;
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 5 || seconds > 300) return Response.json({ error: "超时时间必须是 5 到 300 秒之间的整数。" }, { status: 400 });
  await writeUserAppSetting("browser_bridge_call_timeout_seconds", String(seconds));
  return Response.json({ callTimeoutSeconds: seconds });
});
function localMcpServerId(value: unknown): string {
  if (typeof value !== "string" || (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) && !/^@[a-zA-Z0-9._~-]+\/[a-zA-Z0-9._~-]+$/.test(value))) throw new Error("本地 MCP 编号无效。");
  return value;
}

function localMcpConfig(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本地 MCP 配置无效。");
  const input = value as Record<string, unknown>;
  const command = typeof input.command === "string" ? input.command.trim() : "";
  const args = input.args;
  const env = input.env;
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  if (!command || command.length > 2048 || command.includes("\0")) throw new Error("请填写有效的本地 MCP 启动命令。");
  if (!Array.isArray(args) || args.length > 64 || args.some((item) => typeof item !== "string" || item.length > 4096 || item.includes("\0"))) throw new Error("本地 MCP 参数必须是最多 64 项的字符串数组。");
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("环境变量必须是 JSON 对象。");
  const normalizedEnv: Record<string, string> = {};
  for (const [key, item] of Object.entries(env as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string" || item.length > 8192 || item.includes("\0")) throw new Error("本地 MCP 环境变量格式不正确。");
    normalizedEnv[key] = item;
  }
  if (cwd.includes("\0") || cwd.length > 4096) throw new Error("工作目录格式不正确。");
  return { command, args: args as string[], env: normalizedEnv, cwd };
}

const configureLocalMcp = authenticated(async (request: Request) => {
  const body = await request.json() as Record<string, unknown>;
  const bridge = currentBrowserBridge();
  if (!bridge) return Response.json({ error: "本机 BrowserBridge 未连接。请先启动本机连接程序。" }, { status: 400 });
  const serverId = localMcpServerId(body.serverId);
  const previousServerId = body.previousServerId === undefined ? serverId : localMcpServerId(body.previousServerId);
  const config = localMcpConfig(body.config);
  const result = await callBrowserBridgeCommand("bridge_configure_mcp", { serverId, previousServerId, config }) as { serverId?: string; tools?: BrowserTool[]; mcpServers?: BrowserMcpStatus[] };
  const configuredServerId = result.serverId || serverId;
  return Response.json({ configured: true, serverId: configuredServerId, toolCount: result.tools?.filter((tool) => tool.serverId === configuredServerId).length || 0, mcpServers: result.mcpServers || [] });
});
const getLocalMcpConfig = authenticated(async (request: Request) => {
  const body = await request.json() as Record<string, unknown>;
  const bridge = currentBrowserBridge();
  if (!bridge) return Response.json({ error: "本机 BrowserBridge 未连接。请先启动本机连接程序。" }, { status: 400 });
  const serverId = localMcpServerId(body.serverId);
  return Response.json(await callBrowserBridgeCommand("bridge_get_mcp_config", { serverId }));
});
const removeLocalMcp = authenticated(async (request: Request) => {
  const body = await request.json() as Record<string, unknown>;
  if (!currentBrowserBridge()) return Response.json({ error: "本机 BrowserBridge 未连接。请先启动本机连接程序。" }, { status: 400 });
  const serverId = localMcpServerId(body.serverId);
  const result = await callBrowserBridgeCommand("bridge_remove_mcp", { serverId }) as { mcpServers?: BrowserMcpStatus[] };
  return Response.json({ removed: true, mcpServers: result.mcpServers || [] });
});
const installMysqlMcp = authenticated(async (_request: Request) => {
  if (!currentBrowserBridge()) return Response.json({ error: "本机 BrowserBridge 未连接。请先启动本机连接程序。" }, { status: 400 });
  const result = await callBrowserBridgeCommand("bridge_install_mysql", {}) as { installed?: boolean; installedVersion?: string; installDirectory?: string; mcpServers?: BrowserMcpStatus[] };
  return Response.json(result);
});
const installPlaywrightMcp = authenticated(async (_request: Request) => {
  if (!currentBrowserBridge()) return Response.json({ error: "本机 BrowserBridge 未连接。请先启动本机连接程序。" }, { status: 400 });
  const result = await callBrowserBridgeCommand("bridge_install_playwright", {}) as { installed?: boolean; installedVersion?: string; installDirectory?: string; mcpServers?: BrowserMcpStatus[] };
  return Response.json(result);
});
const installBuiltinMcp = authenticated(async (request: Request) => {
  if (!currentBrowserBridge()) return Response.json({ error: "本机 BrowserBridge 未连接。请先启动本机连接程序。" }, { status: 400 });
  const body = await request.json() as Record<string, unknown>;
  const serverId = localMcpServerId(body.serverId);
  const allowedPackages = new Set([
    "@modelcontextprotocol/server-filesystem",
    "@modelcontextprotocol/server-memory",
    "@modelcontextprotocol/server-sequential-thinking",
    "@modelcontextprotocol/server-everything",
  ]);
  if (!allowedPackages.has(serverId)) return Response.json({ error: "这个内置 MCP 不在允许安装列表中。" }, { status: 400 });
  const result = await callBrowserBridgeCommand("bridge_install_builtin_mcp", { serverId }) as { installed?: boolean; installedVersion?: string; installDirectory?: string; mcpServers?: BrowserMcpStatus[] };
  return Response.json(result);
});
const uninstallMcpPackage = authenticated(async (request: Request) => {
  const body = await request.json() as Record<string, unknown>;
  if (!currentBrowserBridge()) return Response.json({ error: "本机 BrowserBridge 未连接。请先启动本机连接程序。" }, { status: 400 });
  const serverId = localMcpServerId(body.serverId);
  const result = await callBrowserBridgeCommand("bridge_uninstall_mcp", { serverId }) as { uninstalled?: boolean; removedServerId?: string; mcpServers?: BrowserMcpStatus[]; error?: string };
  if (result.uninstalled) {
    let hiddenMcpPluginIds: string[] = [];
    try {
      const hidden = JSON.parse((await readUserAppSetting("hidden_local_mcp_plugin_ids")) || "[]");
      if (Array.isArray(hidden)) hiddenMcpPluginIds = hidden.filter((id): id is string => typeof id === "string");
    } catch { /* Replace malformed account-level hidden plugin settings. */ }
    if (!hiddenMcpPluginIds.includes(serverId)) hiddenMcpPluginIds.push(serverId);
    await writeUserAppSetting("hidden_local_mcp_plugin_ids", JSON.stringify(hiddenMcpPluginIds));
    const matchingServers = (await listExternalMcpServers()).filter((server) => server.transport === "bridge" && server.bridgeServerId === serverId);
    for (const server of matchingServers) await removeExternalMcpServer(server.id);
  }
  return Response.json({ uninstalled: result.uninstalled, removedServerId: result.removedServerId, mcpServers: result.mcpServers || [] });
});

export async function POST(request: Request) {
  try {
    const body = await request.clone().json() as Record<string, unknown>;
    if (body.action === "create-pairing") return createPairing(request);
    if (body.action === "save-call-timeout") return saveCallTimeout(request);
    if (body.action === "local-mcp-configure") return configureLocalMcp(request);
    if (body.action === "local-mcp-config-get") return getLocalMcpConfig(request);
    if (body.action === "local-mcp-remove") return removeLocalMcp(request);
    if (body.action === "mysql-mcp-install") return installMysqlMcp(request);
    if (body.action === "playwright-mcp-install") return installPlaywrightMcp(request);
    if (body.action === "builtin-mcp-install") return installBuiltinMcp(request);
    if (body.action === "local-mcp-uninstall") return uninstallMcpPackage(request);
    if (body.action === "pair") {
      if (typeof body.code !== "string" || !Array.isArray(body.tools) || body.tools.length > 300 || !Array.isArray(body.mcpServers)) throw new Error("配对信息无效。");
      const tools = body.tools as BrowserTool[];
      if (tools.some((tool) => !tool || typeof tool.serverId !== "string" || typeof tool.name !== "string" || typeof tool.inputSchema !== "object")) throw new Error("工具列表无效。");
      const paired = await pairBrowser(body.code, tools, body.mcpServers as BrowserMcpStatus[], bridgeInstallDirectory(body.installDirectory), bridgeVersion(body.bridgeVersion));
      return Response.json(paired);
    }
    if (body.action === "resume") {
      if (!Array.isArray(body.tools) || body.tools.length > 300 || !Array.isArray(body.mcpServers)) throw new Error("桥接恢复信息无效。");
      const tools = body.tools as BrowserTool[];
      if (tools.some((tool) => !tool || typeof tool.serverId !== "string" || typeof tool.name !== "string" || typeof tool.inputSchema !== "object")) throw new Error("工具列表无效。");
      const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
      await resumeBrowserBridge(token, tools, body.mcpServers as BrowserMcpStatus[], bridgeInstallDirectory(body.installDirectory), bridgeVersion(body.bridgeVersion));
      return Response.json({ connected: true });
    }
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    if (body.action === "poll") {
      await persistBrowserBridgeSession(token);
      if (Array.isArray(body.tools) && Array.isArray(body.mcpServers)) updateBrowserBridgeState(token, body.tools as BrowserTool[], body.mcpServers as BrowserMcpStatus[], bridgeInstallDirectory(body.installDirectory), bridgeVersion(body.bridgeVersion));
      return Response.json({ call: nextBrowserCall(token) });
    }
    if (body.action === "complete") {
      if (typeof body.id !== "string") throw new Error("工具调用编号无效。");
      completeBrowserCall(token, body.id, body.result, typeof body.error === "string" ? body.error : undefined);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "未知操作。" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "浏览器连接失败。" }, { status: 400 });
  }
}
