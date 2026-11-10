import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fetch as undiciFetch, ProxyAgent } from "undici";

export async function connectRemoteMcpClient(endpoint: URL, bearerToken?: string) {
  const client = new Client({ name: "usage-copilot-agent", version: "1.0.0" });
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  const proxyFetch = proxyAgent
    ? (input: string | URL, init?: RequestInit) => undiciFetch(input, { ...init, dispatcher: proxyAgent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>
    : undefined;
  const transport = new StreamableHTTPClientTransport(endpoint, {
    ...(bearerToken ? { requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } } } : {}),
    ...(proxyFetch ? { fetch: proxyFetch } : {}),
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await Promise.allSettled([client.close(), proxyAgent?.close() || Promise.resolve()]);
    throw error;
  }
  return {
    client,
    close: async () => {
      await Promise.allSettled([client.close(), proxyAgent?.close() || Promise.resolve()]);
    },
  };
}

export async function connectLocalMcpClient(input: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }) {
  if (process.env.LITTLE_SUNSHINE_RUNTIME !== "desktop") throw new Error("本地命令 MCP 只能在 Desktop 版中运行。");
  const client = new Client({ name: "usage-copilot-agent", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: input.command,
    args: input.args || [],
    ...(input.env ? { env: input.env } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    stderr: "inherit",
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await Promise.allSettled([client.close()]);
    throw error;
  }
  return { client, close: async () => { await Promise.allSettled([client.close()]); } };
}

export async function callMcpTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const blocks = result.content as Array<{ type: string; text?: string }>;
    const detail = blocks.filter((block) => block.type === "text").map((block) => block.text || "").filter(Boolean).join("\n").replace(/Bearer\s+[^\s,"']+/gi, "Bearer [已隐藏]").slice(0, 1500);
    console.warn("MCP tool returned an error", { name, detail: detail || "No error details returned." });
    if (name === "query_usage") throw new Error("使用记录查询工具未能完成请求。请检查数据库连接、数据表名和字段配置；详情请查看服务端日志。");
    throw new Error(detail ? `MCP 工具 ${name} 执行失败：${detail}` : "MCP 工具执行失败，请检查该工具的配置和服务状态；详情请查看服务端日志。");
  }
  const blocks = result.content as Array<{ type: string; text?: string }>;
  const texts = blocks.filter((block) => block.type === "text").map((block) => block.text || "");
  if (!texts.length) return result.content;
  const joined = texts.join("\n");
  try { return JSON.parse(joined) as unknown; } catch { return joined; }
}
