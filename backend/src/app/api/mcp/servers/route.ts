import { authenticated } from "@/lib/auth";
import { connectLocalMcpClient, connectRemoteMcpClient } from "@/lib/mcp-client";
import { ensureInternalMcpServers, isDesktopMcpRuntime, listExternalMcpServers, removeExternalMcpServer, saveExternalMcpServer, updateExternalMcpServer, type ExternalMcpServer } from "@/lib/external-mcp-config";
import { currentBrowserBridge, type BrowserTool } from "@/lib/browser-bridge";
import { callBrowserBridgeCommand } from "@/lib/browser-bridge";
import { internalMcpCatalog } from "@/mcp-modules";
import { readUserAppSetting, writeUserAppSetting } from "@/lib/local-db";
import { getLegacyWebSearchProviderCredentials } from "@/lib/web-search-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toolView(tool: { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; readOnly?: boolean; destructive?: boolean; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }, disabledTools: string[] = [], allowedTools: string[] = [], isBrowserBridge = false, bridgeServerId = "") {
  const internalMysqlReadOnlyTool = isBrowserBridge && bridgeServerId === "mysql" && isManuallyEnableableMySqlTool(tool.name);
  const destructive = internalMysqlReadOnlyTool ? false : tool.annotations?.destructiveHint ?? tool.destructive ?? false;
  const readOnly = internalMysqlReadOnlyTool || ((tool.annotations?.readOnlyHint ?? tool.readOnly ?? false) && !destructive);
  const manuallyAllowed = allowedTools.includes(tool.name);
  const canEnable = !destructive || isBrowserBridge;
  return { name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, readOnly, destructive, manuallyAllowed, canEnable, enabled: canEnable && (readOnly || manuallyAllowed) && !disabledTools.includes(tool.name) };
}

function isManuallyEnableableMySqlTool(name: string) {
  return ["mysql_get_server_info", "mysql_list_databases", "mysql_list_tables", "mysql_describe_table", "mysql_list_indexes", "mysql_query"].includes(name);
}

function publicServer(server: ExternalMcpServer) {
  const { token, env, ...safe } = server;
  return { ...safe, hasToken: Boolean(token), envKeys: Object.keys(env), hasEnv: Object.keys(env).length > 0 };
}

function isInternalBridgeServer(server: ExternalMcpServer) { return server.transport === "bridge" || server.name === "内部工具" || server.name === "内部工具：Playwright MCP" || server.name === "内部工具：MySQL MCP"; }
function bridgeMcpId(server: ExternalMcpServer) { return server.bridgeServerId || (server.name === "内部工具：Playwright MCP" ? "playwright" : server.name === "内部工具：MySQL MCP" ? "mysql" : ""); }
function toolBelongsToInternalServer(server: ExternalMcpServer, tool: BrowserTool) { const id = bridgeMcpId(server); return id ? tool.serverId === id : true; }

async function inspectConfigured(server: ExternalMcpServer): Promise<ReturnType<typeof toolView>[]> {
  const isBrowserBridge = isInternalBridgeServer(server);
  let tools: ReturnType<typeof toolView>[];
  if (isBrowserBridge) {
    const bridge = currentBrowserBridge();
    if (!bridge) throw new Error("本机 BrowserBridge 未连接。请先启动本机连接程序。");
    const internalId = bridgeMcpId(server);
    const matchingTools = bridge.tools.filter((tool: BrowserTool) => toolBelongsToInternalServer(server, tool));
    if (server.name === "内部工具：MySQL MCP" && !matchingTools.length) throw new Error("本机 MySQL MCP 尚未配置或未启动，请在桥接工具页面配置本地命令。");
    if (server.name === "内部工具：Playwright MCP" && !matchingTools.length) throw new Error("本机 Playwright MCP 尚未配置或未启动，请在桥接工具页面配置本地命令。");
    if (server.transport === "bridge" && !matchingTools.length) throw new Error("本机 MCP 尚未启动，请检查 BrowserBridge 连接状态。");
    tools = matchingTools.map((tool: BrowserTool) => toolView(tool, [], [], true, internalId));
  } else {
    tools = await inspect(server);
  }
  return tools.map((tool) => toolView(tool, server.disabledTools, server.allowedTools, isBrowserBridge, isBrowserBridge ? bridgeMcpId(server) : ""));
}

async function inspect(server: Pick<ExternalMcpServer, "transport" | "url" | "token" | "command" | "args" | "env" | "cwd">) {
  let mcp: Awaited<ReturnType<typeof connectRemoteMcpClient>>;
  try {
    if (server.transport === "stdio") {
      if (!isDesktopMcpRuntime()) throw new Error("本地命令 MCP 只能在 Desktop 版中运行。");
      mcp = await connectLocalMcpClient(server);
    } else {
      mcp = await connectRemoteMcpClient(new URL(server.url), server.token);
    }
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
    const detail = cause ? `${error instanceof Error ? error.message : "连接失败"}：${cause.message}` : error instanceof Error ? error.message : "未知网络错误";
    throw new Error(server.transport === "stdio"
      ? `启动本地 MCP 命令失败（${detail}）。请检查命令、参数、工作目录和运行环境。`
      : `连接远程 MCP 失败（${detail}）。请确认运行 Little Sunshine 的设备可以访问 ${new URL(server.url).host}，且该服务支持 Streamable HTTP。`);
  }
  try {
    const result = await mcp.client.listTools();
    return result.tools.map((tool) => toolView(tool));
  } finally {
    await mcp.close();
  }
}

async function handlerGET(request: Request) {
  try {
    const legacyTavily = await getLegacyWebSearchProviderCredentials("tavily");
    if (legacyTavily.apiKey) {
      const tavilyUrl = "https://mcp.tavily.com/mcp";
      const existingTavily = (await listExternalMcpServers()).find((server) => server.transport === "http" && server.url.replace(/\/+$/, "") === tavilyUrl);
      if (!existingTavily) {
        const server = await saveExternalMcpServer({ name: "Tavily", transport: "http", url: tavilyUrl, token: legacyTavily.apiKey });
        if (!legacyTavily.enabled) await updateExternalMcpServer(server.id, { enabled: false });
      } else if (!existingTavily.token) {
        await saveExternalMcpServer({ id: existingTavily.id, name: existingTavily.name, transport: "http", url: existingTavily.url, token: legacyTavily.apiKey });
      }
    }
    const servers = await ensureInternalMcpServers(internalMcpCatalog);
    return Response.json({ runtime: isDesktopMcpRuntime() ? "desktop" : "web", servers: servers.filter((server) => server.transport !== "stdio" || isDesktopMcpRuntime()).map(publicServer) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取外部 MCP 配置失败。" }, { status: 500 });
  }
}
export const GET = authenticated(handlerGET);

async function handlerPOST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    if (body.action === "test") {
      const transport = body.transport === "stdio" ? "stdio" : "http";
      const savedToken = transport === "http" && typeof body.id === "string" ? (await listExternalMcpServers()).find((item) => item.id === body.id)?.token || "" : "";
      if (transport === "stdio" && !isDesktopMcpRuntime()) return Response.json({ error: "本地命令 MCP 只能在 Desktop 版中配置和运行。" }, { status: 400 });
      if (transport === "http" && typeof body.url !== "string") return Response.json({ error: "请填写 MCP 地址。" }, { status: 400 });
      if (transport === "stdio") {
        const env = body.env && typeof body.env === "object" && !Array.isArray(body.env) ? body.env as Record<string, unknown> : {};
        const args = Array.isArray(body.args) ? body.args : [];
        if (typeof body.command !== "string" || !body.command.trim() || body.command.length > 2048 || body.command.includes("\0") || args.length > 64 || args.some((item) => typeof item !== "string" || item.length > 4096 || item.includes("\0")) || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.length > 8192 || value.includes("\0")) || (typeof body.cwd === "string" && body.cwd.includes("\0"))) return Response.json({ error: "本地 MCP 命令、参数或环境变量格式不正确。" }, { status: 400 });
      }
      const tools = await inspect({ transport, url: typeof body.url === "string" ? body.url : "", token: typeof body.token === "string" && body.token.trim() ? body.token : savedToken, command: typeof body.command === "string" ? body.command : "", args: Array.isArray(body.args) ? body.args.filter((item): item is string => typeof item === "string") : [], env: body.env && typeof body.env === "object" && !Array.isArray(body.env) ? body.env as Record<string, string> : {}, cwd: typeof body.cwd === "string" ? body.cwd : "" });
      return Response.json({ tools, readOnlyToolCount: tools.filter((tool) => tool.readOnly).length });
    }
    if (body.action === "inspect") {
      if (typeof body.id !== "string") return Response.json({ error: "缺少 MCP 配置编号。" }, { status: 400 });
      const server = (await listExternalMcpServers()).find((item) => item.id === body.id);
      if (!server) return Response.json({ error: "未找到外部 MCP 配置。" }, { status: 404 });
      const tools = await inspectConfigured(server);
      return Response.json({ tools: tools.map((tool) => ({ ...tool, enabled: server.enabled && tool.enabled })) });
    }
    if (body.action === "save") {
      const server = await saveExternalMcpServer({ id: body.id, name: body.name, transport: body.transport, url: body.url, token: body.token, command: body.command, args: body.args, env: body.env, cwd: body.cwd });
      return Response.json({ server: publicServer(server) });
    }
    if (body.action === "save-bridge") {
      if (typeof body.name !== "string" || typeof body.bridgeServerId !== "string") return Response.json({ error: "请填写本地 MCP 名称和编号。" }, { status: 400 });
      const previousBridgeServerId = body.previousBridgeServerId === undefined ? "" : typeof body.previousBridgeServerId === "string" ? body.previousBridgeServerId : "";
      if (previousBridgeServerId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(previousBridgeServerId) && !/^@[a-zA-Z0-9._~-]+\/[a-zA-Z0-9._~-]+$/.test(previousBridgeServerId)) return Response.json({ error: "原本地 MCP 编号无效。" }, { status: 400 });
      const bridge = currentBrowserBridge();
      if (!bridge?.mcpServers.some((item) => item.id === body.bridgeServerId && item.connected)) return Response.json({ error: "本机 MCP 尚未连接，无法保存。" }, { status: 400 });
      const existing = (await listExternalMcpServers()).find((item) => item.transport === "bridge" && (item.bridgeServerId === body.bridgeServerId || item.bridgeServerId === previousBridgeServerId));
      const server = await saveExternalMcpServer({ id: existing?.id, name: body.name, transport: "bridge", bridgeServerId: body.bridgeServerId });
      try {
        const hidden = JSON.parse((await readUserAppSetting("hidden_local_mcp_plugin_ids")) || "[]");
        const idsToUnhide = new Set([body.bridgeServerId, previousBridgeServerId]);
        if (Array.isArray(hidden) && hidden.some((id) => idsToUnhide.has(id))) {
          await writeUserAppSetting("hidden_local_mcp_plugin_ids", JSON.stringify(hidden.filter((id) => !idsToUnhide.has(id))));
        }
      } catch { /* Keep saving the configured MCP even if a stale hide setting is malformed. */ }
      return Response.json({ server: publicServer(server) });
    }
    if (body.action === "toggle-server" && typeof body.id === "string" && typeof body.enabled === "boolean") {
      const server = await updateExternalMcpServer(body.id, { enabled: body.enabled });
      return Response.json({ id: server.id, enabled: server.enabled });
    }
    if (body.action === "toggle-tool" && typeof body.id === "string" && typeof body.name === "string" && typeof body.enabled === "boolean") {
      const server = (await listExternalMcpServers()).find((item) => item.id === body.id);
      if (!server) return Response.json({ error: "未找到外部 MCP 配置。" }, { status: 404 });
      const tools = await inspectConfigured(server);
      const tool = tools.find((item) => item.name === body.name);
      if (!tool) return Response.json({ error: "未找到该 MCP 工具。" }, { status: 404 });
      const explicitlyEnableableBridgeTool = isInternalBridgeServer(server);
      if (tool.destructive && !explicitlyEnableableBridgeTool) return Response.json({ error: "该工具声明为有破坏性操作，不能启用。" }, { status: 400 });
      const manuallyAllowTool = !tool.readOnly;
      const updated = await updateExternalMcpServer(body.id, { toolName: body.name, toolEnabled: body.enabled, manuallyAllowTool });
      return Response.json({ id: updated.id, name: body.name, enabled: updated.enabled && !updated.disabledTools.includes(body.name) && (tool.readOnly || updated.allowedTools.includes(body.name)), manuallyAllowed: updated.allowedTools.includes(body.name) });
    }
    if (body.action === "delete" && typeof body.id === "string") {
      const server = (await listExternalMcpServers()).find((item) => item.id === body.id);
      if (server?.transport === "bridge" && currentBrowserBridge()) {
        await callBrowserBridgeCommand("bridge_remove_mcp", { serverId: server.bridgeServerId });
      }
      await removeExternalMcpServer(body.id);
      return Response.json({ deleted: true });
    }
    return Response.json({ error: "不支持的外部 MCP 操作。" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "外部 MCP 操作失败。" }, { status: 500 });
  }
}
export const POST = authenticated(handlerPOST);
