import { readUserAppSetting, writeUserAppSetting } from "@/lib/local-db";

const settingKey = "web_search_mcp_config";
export type WebSearchProviderId = "tavily" | "exa" | "firecrawl";
type WebSearchProviderConfig = { endpoint: string; apiKey: string };
type WebSearchSettings = { enabled: boolean; activeProvider: WebSearchProviderId | null; providers: Partial<Record<WebSearchProviderId, WebSearchProviderConfig>> };
export type PublicWebSearchMcpConfig = { enabled: boolean; activeProvider: WebSearchProviderId | null; providers: Partial<Record<WebSearchProviderId, { endpoint: string; hasApiKey: boolean }>> };

export const webSearchProviderCatalog: Record<WebSearchProviderId, { name: string; endpoint: string; description: string; requiresApiKey: boolean }> = {
  tavily: { name: "Tavily", endpoint: "https://mcp.tavily.com/mcp", description: "实时网页搜索与内容提取", requiresApiKey: true },
  exa: { name: "Exa", endpoint: "https://mcp.exa.ai/mcp", description: "网页搜索与内容检索", requiresApiKey: false },
  firecrawl: { name: "Firecrawl", endpoint: "https://mcp.firecrawl.dev/v2/mcp", description: "网页搜索与网页内容抓取", requiresApiKey: true },
};

function isProviderId(value: unknown): value is WebSearchProviderId {
  return value === "tavily" || value === "exa" || value === "firecrawl";
}

function normalizeConfig(value: unknown, providerId: WebSearchProviderId): WebSearchProviderConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const config = value as Partial<WebSearchProviderConfig>;
  // Provider endpoints are fixed to the official hosted MCP services. Never allow a
  // saved setting to turn this server-side connection into an arbitrary URL fetch.
  return { endpoint: webSearchProviderCatalog[providerId].endpoint, apiKey: typeof config.apiKey === "string" ? config.apiKey : "" };
}

async function readSettings(): Promise<WebSearchSettings> {
  const raw = await readUserAppSetting(settingKey);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<WebSearchSettings>;
      const providers: WebSearchSettings["providers"] = {};
      if (parsed.providers && typeof parsed.providers === "object") {
        for (const id of ["tavily", "exa", "firecrawl"] as const) {
          const config = normalizeConfig(parsed.providers[id], id);
          if (config) providers[id] = config;
        }
      }
      const activeProvider = isProviderId(parsed.activeProvider) && providers[parsed.activeProvider] ? parsed.activeProvider : null;
      const activeConfig = activeProvider ? providers[activeProvider] : undefined;
      const activeCredentialsReady = Boolean(activeProvider && activeConfig && (!webSearchProviderCatalog[activeProvider].requiresApiKey || activeConfig.apiKey));
      return { enabled: Boolean(parsed.enabled && activeCredentialsReady), activeProvider, providers };
    } catch { /* Malformed settings are treated as unconfigured. */ }
  }
  return { enabled: false, activeProvider: null, providers: {} };
}

export async function getActiveWebSearchMcpConfig() {
  const settings = await readSettings();
  const providerId = settings.activeProvider;
  const config = providerId ? settings.providers[providerId] : undefined;
  if (!settings.enabled || !providerId || !config || (webSearchProviderCatalog[providerId].requiresApiKey && !config.apiKey)) return null;
  return { providerId, ...config };
}

export async function getLegacyWebSearchProviderCredentials(providerId: WebSearchProviderId) {
  const settings = await readSettings();
  return {
    apiKey: settings.providers[providerId]?.apiKey || "",
    enabled: settings.enabled && settings.activeProvider === providerId,
  };
}

export async function getPublicWebSearchMcpConfig(): Promise<PublicWebSearchMcpConfig> {
  const settings = await readSettings();
  const providers: PublicWebSearchMcpConfig["providers"] = {};
  for (const id of ["tavily", "exa", "firecrawl"] as const) {
    const config = settings.providers[id];
    if (config) providers[id] = { endpoint: config.endpoint, hasApiKey: Boolean(config.apiKey) };
  }
  return { enabled: settings.enabled, activeProvider: settings.activeProvider, providers };
}

export async function saveWebSearchMcpConfig(input: { providerId?: unknown; apiKey?: unknown; activate?: unknown }) {
  const settings = await readSettings();
  if (!isProviderId(input.providerId)) throw new Error("请选择网页搜索服务商。");
  const providerId = input.providerId;
  const previous = settings.providers[providerId];
  const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : previous?.apiKey || "";
  if (webSearchProviderCatalog[providerId].requiresApiKey && !apiKey) throw new Error(`请填写 ${webSearchProviderCatalog[providerId].name} API Key。`);
  settings.providers[providerId] = { endpoint: webSearchProviderCatalog[providerId].endpoint, apiKey };
  if (input.activate !== false || !settings.activeProvider) {
    settings.activeProvider = providerId;
    settings.enabled = true;
  }
  await writeUserAppSetting(settingKey, JSON.stringify(settings));
  return getPublicWebSearchMcpConfig();
}

export async function activateWebSearchMcpProvider(providerId: unknown) {
  if (!isProviderId(providerId)) throw new Error("网页搜索服务商无效。");
  const settings = await readSettings();
  if (!settings.providers[providerId]) throw new Error("请先配置该网页搜索服务商。");
  if (webSearchProviderCatalog[providerId].requiresApiKey && !settings.providers[providerId]?.apiKey) throw new Error(`请先填写 ${webSearchProviderCatalog[providerId].name} API Key。`);
  settings.enabled = true;
  settings.activeProvider = providerId;
  await writeUserAppSetting(settingKey, JSON.stringify(settings));
  return getPublicWebSearchMcpConfig();
}

export function isWebSearchToolName(name: string) {
  return /search/i.test(name) && !/(code|github|image|map|crawl|research)/i.test(name) || ["tavily_search", "web_search_exa", "firecrawl_search"].includes(name);
}

