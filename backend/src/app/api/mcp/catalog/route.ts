import { authenticated } from "@/lib/auth";
import { internalMcpCatalog } from "@/mcp-modules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type McpEntry = { id: string; name: string; description: string; url: string };

async function handlerGET() {
  return Response.json({ mcps: internalMcpCatalog });
}
export const GET = authenticated(handlerGET);

async function handlerPOST(request: Request) {
  try {
    const body = await request.json() as { url?: unknown };
    if (typeof body.url !== "string") return Response.json({ error: "请填写 MCP 列表地址。" }, { status: 400 });
    const catalogUrl = new URL(body.url);
    if (!["http:", "https:"].includes(catalogUrl.protocol)) return Response.json({ error: "MCP 列表地址必须使用 HTTP 或 HTTPS。" }, { status: 400 });
    const response = await fetch(catalogUrl, { signal: AbortSignal.timeout(10000), cache: "no-store" });
    if (!response.ok) throw new Error(`MCP 列表请求失败（HTTP ${response.status}）。`);
    const data = await response.json() as { mcps?: unknown };
    if (!Array.isArray(data.mcps)) throw new Error("MCP 列表格式不正确。");
    const mcps: McpEntry[] = data.mcps.map((item: unknown) => {
      if (!item || typeof item !== "object") throw new Error("MCP 列表格式不正确。");
      const entry = item as Record<string, unknown>;
      if ([entry.id, entry.name, entry.description, entry.url].some((value) => typeof value !== "string")) throw new Error("MCP 列表缺少名称、用途或地址。");
      const endpoint = new URL(entry.url as string);
      if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("MCP 服务地址必须使用 HTTP 或 HTTPS。");
      return { id: entry.id as string, name: entry.name as string, description: entry.description as string, url: endpoint.toString() };
    });
    return Response.json({ mcps });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "获取 MCP 列表失败。" }, { status: 400 });
  }
}

export const POST = authenticated(handlerPOST);
