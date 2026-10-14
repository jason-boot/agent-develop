import { connectUsageMcpClient } from "@/lib/usage-mcp";
import { listExternalMcpServers, removeExternalMcpServer, saveExternalMcpServer, updateExternalMcpServer } from "@/lib/external-mcp-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toolView(tool: { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }, disabledTools: string[] = [], allowedTools: string[] = []) {
  const readOnly = tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true;
  const destructive = tool.annotations?.destructiveHint === true;
  const manuallyAllowed = allowedTools.includes(tool.name);
  return { name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, readOnly, destructive, manuallyAllowed, canEnable: !destructive, enabled: !destructive && (readOnly || manuallyAllowed) && !disabledTools.includes(tool.name) };
}

async function inspect(url: string, token?: string) {
  const endpoint = new URL(url);
  let mcp: Awaited<ReturnType<typeof connectUsageMcpClient>>;
  try {
    mcp = await connectUsageMcpClient(endpoint, token);
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
    const detail = cause ? `${error instanceof Error ? error.message : "连接失败"}：${cause.message}` : error instanceof Error ? error.message : "未知网络错误";
    throw new Error(`连接远程 MCP 失败（${detail}）。请确认运行 Little Sunshine 的设备可以访问 ${endpoint.host}，且该服务支持 Streamable HTTP。`);
  }
  try {
    const result = await mcp.client.listTools();
    return result.tools.map((tool) => toolView(tool));
  } finally {
    await mcp.close();
  }
}

export async function GET() {
  try {
    const servers = await listExternalMcpServers();
    return Response.json({ servers: servers.map(({ token, ...server }) => ({ ...server, hasToken: Boolean(token) })) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取外部 MCP 配置失败。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    if (body.action === "test") {
      if (typeof body.url !== "string") return Response.json({ error: "请填写 MCP 地址。" }, { status: 400 });
      const tools = await inspect(body.url, typeof body.token === "string" ? body.token : undefined);
      return Response.json({ tools, readOnlyToolCount: tools.filter((tool) => tool.readOnly).length });
    }
    if (body.action === "inspect") {
      if (typeof body.id !== "string") return Response.json({ error: "缺少 MCP 配置编号。" }, { status: 400 });
      const server = (await listExternalMcpServers()).find((item) => item.id === body.id);
      if (!server) return Response.json({ error: "未找到外部 MCP 配置。" }, { status: 404 });
      const tools = await inspect(server.url, server.token);
      return Response.json({ tools: tools.map((tool) => ({ ...tool, ...toolView(tool, server.disabledTools, server.allowedTools), enabled: server.enabled && !tool.destructive && (tool.readOnly || server.allowedTools.includes(tool.name)) && !server.disabledTools.includes(tool.name) })) });
    }
    if (body.action === "save") {
      const server = await saveExternalMcpServer({ id: body.id, name: body.name, url: body.url, token: body.token });
      const { token, ...publicServer } = server;
      return Response.json({ server: { ...publicServer, hasToken: Boolean(token) } });
    }
    if (body.action === "toggle-server" && typeof body.id === "string" && typeof body.enabled === "boolean") {
      const server = await updateExternalMcpServer(body.id, { enabled: body.enabled });
      return Response.json({ id: server.id, enabled: server.enabled });
    }
    if (body.action === "toggle-tool" && typeof body.id === "string" && typeof body.name === "string" && typeof body.enabled === "boolean") {
      const server = (await listExternalMcpServers()).find((item) => item.id === body.id);
      if (!server) return Response.json({ error: "未找到外部 MCP 配置。" }, { status: 404 });
      const tools = await inspect(server.url, server.token);
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
