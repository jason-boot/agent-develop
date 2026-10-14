import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fetch as undiciFetch, ProxyAgent } from "undici";

export async function connectUsageMcpClient(endpoint: URL, bearerToken?: string) {
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

export async function callUsageMcpTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const message = name === "query_usage"
      ? "使用记录查询工具未能完成请求。请检查数据库连接、数据表名和字段配置；详情请查看服务端日志。"
      : "MCP 工具执行失败，请检查该工具的配置和服务状态；详情请查看服务端日志。";
    throw new Error(message);
  }
  const blocks = result.content as Array<{ type: string; text?: string }>;
  const texts = blocks.filter((block) => block.type === "text").map((block) => block.text || "");
  if (!texts.length) return result.content;
  const joined = texts.join("\n");
  try { return JSON.parse(joined) as unknown; } catch { return joined; }
}
