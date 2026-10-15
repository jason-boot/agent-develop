import { authenticated } from "@/lib/auth";
import { connectLocalUsageMcpClient, connectUsageMcpClient } from "@/lib/usage-mcp";
import { isDesktopMcpRuntime, listExternalMcpServers, removeExternalMcpServer, saveExternalMcpServer, updateExternalMcpServer, type ExternalMcpServer } from "@/lib/external-mcp-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toolView(tool: { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }, disabledTools: string[] = [], allowedTools: string[] = []) {
  const readOnly = tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true;
  const destructive = tool.annotations?.destructiveHint === true;
  const manuallyAllowed = allowedTools.includes(tool.name);
  return { name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, readOnly, destructive, manuallyAllowed, canEnable: !destructive, enabled: !destructive && (readOnly || manuallyAllowed) && !disabledTools.includes(tool.name) };
}

function publicServer(server: ExternalMcpServer) {
  const { token, env, ...safe } = server;
  return { ...safe, hasToken: Boolean(token), envKeys: Object.keys(env), hasEnv: Object.keys(env).length > 0 };
}

async function inspect(server: Pick<ExternalMcpServer, "transport" | "url" | "token" | "command" | "args" | "env" | "cwd">) {
  let mcp: Awaited<ReturnType<typeof connectUsageMcpClient>>;
  try {
    if (server.transport === "stdio") {
      if (!isDesktopMcpRuntime()) throw new Error("本地命令 MCP 只能在 Desktop 版中运行。");
      mcp = await connectLocalUsageMcpClient(server);
    } else {
      mcp = await connectUsageMcpClient(new URL(server.url), server.token);
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
    const servers = await listExternalMcpServers();
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
      if (transport === "stdio" && !isDesktopMcpRuntime()) return Response.json({ error: "本地命令 MCP 只能在 Desktop 版中配置和运行。" }, { status: 400 });
      if (transport === "http" && typeof body.url !== "string") return Response.json({ error: "请填写 MCP 地址。" }, { status: 400 });
      if (transport === "stdio") {
        const env = body.env && typeof body.env === "object" && !Array.isArray(body.env) ? body.env as Record<string, unknown> : {};
        const args = Array.isArray(body.args) ? body.args : [];
        if (typeof body.command !== "string" || !body.command.trim() || body.command.length > 2048 || body.command.includes("\0") || args.length > 64 || args.some((item) => typeof item !== "string" || item.length > 4096 || item.includes("\0")) || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.length > 8192 || value.includes("\0")) || (typeof body.cwd === "string" && body.cwd.includes("\0"))) return Response.json({ error: "本地 MCP 命令、参数或环境变量格式不正确。" }, { status: 400 });
      }
      const tools = await inspect({ transport, url: typeof body.url === "string" ? body.url : "", token: typeof body.token === "string" ? body.token : "", command: typeof body.command === "string" ? body.command : "", args: Array.isArray(body.args) ? body.args.filter((item): item is string => typeof item === "string") : [], env: body.env && typeof body.env === "object" && !Array.isArray(body.env) ? body.env as Record<string, string> : {}, cwd: typeof body.cwd === "string" ? body.cwd : "" });
      return Response.json({ tools, readOnlyToolCount: tools.filter((tool) => tool.readOnly).length });
    }
    if (body.action === "inspect") {
      if (typeof body.id !== "string") return Response.json({ error: "缺少 MCP 配置编号。" }, { status: 400 });
      const server = (await listExternalMcpServers()).find((item) => item.id === body.id);
      if (!server) return Response.json({ error: "未找到外部 MCP 配置。" }, { status: 404 });
      const tools = await inspect(server);
      return Response.json({ tools: tools.map((tool) => ({ ...tool, ...toolView(tool, server.disabledTools, server.allowedTools), enabled: server.enabled && !tool.destructive && (tool.readOnly || server.allowedTools.includes(tool.name)) && !server.disabledTools.includes(tool.name) })) });
    }
    if (body.action === "save") {
      const server = await saveExternalMcpServer({ id: body.id, name: body.name, transport: body.transport, url: body.url, token: body.token, command: body.command, args: body.args, env: body.env, cwd: body.cwd });
      return Response.json({ server: publicServer(server) });
    }
    if (body.action === "toggle-server" && typeof body.id === "string" && typeof body.enabled === "boolean") {
      const server = await updateExternalMcpServer(body.id, { enabled: body.enabled });
      return Response.json({ id: server.id, enabled: server.enabled });
    }
    if (body.action === "toggle-tool" && typeof body.id === "string" && typeof body.name === "string" && typeof body.enabled === "boolean") {
      const server = (await listExternalMcpServers()).find((item) => item.id === body.id);
      if (!server) return Response.json({ error: "未找到外部 MCP 配置。" }, { status: 404 });
      const tools = await inspect(server);
      const tool = tools.find((item) => item.name === body.name);
      if (!tool) return Response.json({ error: "未找到该 MCP 工具。" }, { status: 404 });
      if (tool.destructive) return Response.json({ error: "该工具声明为有破坏性操作，不能启用。" }, { status: 400 });
      const manuallyAllowTool = !tool.readOnly;
      const updated = await updateExternalMcpServer(body.id, { toolName: body.name, toolEnabled: body.enabled, manuallyAllowTool });
      return Response.json({ id: updated.id, name: body.name, enabled: updated.enabled && !updated.disabledTools.includes(body.name) && (tool.readOnly || updated.allowedTools.includes(body.name)), manuallyAllowed: updated.allowedTools.includes(body.name) });
    }
    if (body.action === "delete" && typeof body.id === "string") {
      await removeExternalMcpServer(body.id);
      return Response.json({ deleted: true });
    }
    return Response.json({ error: "不支持的外部 MCP 操作。" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "外部 MCP 操作失败。" }, { status: 500 });
  }
}
export const POST = authenticated(handlerPOST);
