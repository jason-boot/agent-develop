import { createHash, randomBytes, randomUUID } from "node:crypto";
import { currentUserId, findBrowserBridgeSession, findUserById, readUserAppSetting, saveBrowserBridgeSession } from "@/lib/local-db";

export type BrowserTool = { serverId: string; name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } };
export type BrowserMcpStatus = { id: string; configured: boolean; connected: boolean; toolCount: number; installSource?: string; installDirectory?: string; packageName?: string; installed?: boolean; installedVersion?: string; error?: string };
type BrowserBridgeCommand = "bridge_configure_mcp" | "bridge_get_mcp_config" | "bridge_remove_mcp" | "bridge_install_mysql" | "bridge_install_playwright" | "bridge_install_builtin_mcp" | "bridge_uninstall_mcp";
export const LATEST_BROWSER_BRIDGE_VERSION = "2.0.19";
type Pending = { name: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Bridge = { userId: number; token: string; tools: BrowserTool[]; mcpServers: BrowserMcpStatus[]; installDirectory: string; version: string; lastSeen: number; pending: Map<string, Pending> };
type Store = { pairings: Map<string, { userId: number; expiresAt: number }>; bridges: Map<string, Bridge> };

const globalStore = globalThis as typeof globalThis & { browserBridgeStore?: Store; browserBridgePersistedTokens?: Set<string> };
const store = globalStore.browserBridgeStore ||= { pairings: new Map(), bridges: new Map() };
const persistedTokens = globalStore.browserBridgePersistedTokens ||= new Set<string>();

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createBrowserPairing() {
  const code = randomBytes(24).toString("base64url");
  store.pairings.set(code, { userId: currentUserId(), expiresAt: Date.now() + 60 * 60_000 });
  return code;
}

export async function pairBrowser(code: string, tools: BrowserTool[], mcpServers: BrowserMcpStatus[] = [], installDirectory = "", version = "") {
  const pairing = store.pairings.get(code);
  if (!pairing || pairing.expiresAt < Date.now()) throw new Error("配对码无效或已过期。");
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  await saveBrowserBridgeSession(pairing.userId, tokenHash);
  persistedTokens.add(tokenHash);
  store.pairings.delete(code);
  const previous = store.bridges.get(String(pairing.userId));
  if (previous) for (const pending of previous.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("本机浏览器连接已更换。")); }
  store.bridges.set(String(pairing.userId), { userId: pairing.userId, token, tools, mcpServers, installDirectory, version, lastSeen: Date.now(), pending: new Map() });
  return { token, configScope: String(pairing.userId) };
}

export async function resumeBrowserBridge(token: string, tools: BrowserTool[], mcpServers: BrowserMcpStatus[] = [], installDirectory = "", version = "") {
  const existing = [...store.bridges.values()].find((bridge) => bridge.token === token);
  if (existing) {
    existing.tools = tools;
    existing.mcpServers = mcpServers;
    if (installDirectory !== undefined) existing.installDirectory = installDirectory;
    if (version !== undefined) existing.version = version;
    existing.lastSeen = Date.now();
    return;
  }
  const session = await findBrowserBridgeSession(hashToken(token));
  const user = session ? await findUserById(session.userId) : null;
  if (!session || !user?.isActive) throw new Error("本机浏览器连接无效。");
  const key = String(session.userId);
  const previous = store.bridges.get(key);
  if (previous) for (const pending of previous.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("本机浏览器连接已恢复。")); }
  store.bridges.set(key, { userId: session.userId, token, tools, mcpServers, installDirectory, version, lastSeen: Date.now(), pending: new Map() });
  persistedTokens.add(hashToken(token));
}

export async function persistBrowserBridgeSession(token: string) {
  const bridge = [...store.bridges.values()].find((item) => item.token === token);
  if (!bridge) throw new Error("本机浏览器连接无效。");
  const tokenHash = hashToken(token);
  if (persistedTokens.has(tokenHash)) return;
  await saveBrowserBridgeSession(bridge.userId, tokenHash);
  persistedTokens.add(tokenHash);
}

export function currentBrowserBridge() {
  const bridge = store.bridges.get(String(currentUserId()));
  return bridge && Date.now() - bridge.lastSeen < 15_000 ? bridge : null;
}

export function browserBridgeByToken(token: string) {
  const bridge = [...store.bridges.values()].find((item) => item.token === token);
  if (!bridge) throw new Error("本机浏览器连接无效。");
  bridge.lastSeen = Date.now();
  return bridge;
}

export function nextBrowserCall(token: string) {
  const bridge = browserBridgeByToken(token);
  const queue = bridge as Bridge & { queue?: Array<{ id: string; serverId: string; name: string; arguments: Record<string, unknown> }> };
  return queue.queue?.shift() || null;
}

export function updateBrowserBridgeState(token: string, tools: BrowserTool[], mcpServers: BrowserMcpStatus[], installDirectory?: string, version?: string) {
  const bridge = browserBridgeByToken(token);
  bridge.tools = tools;
  bridge.mcpServers = mcpServers;
  if (installDirectory !== undefined) bridge.installDirectory = installDirectory;
  if (version !== undefined) bridge.version = version;
}

export function completeBrowserCall(token: string, id: string, result: unknown, error?: string) {
  const bridge = browserBridgeByToken(token);
  const pending = bridge.pending.get(id);
  if (!pending) throw new Error("工具调用不存在或已超时。");
  bridge.pending.delete(id); clearTimeout(pending.timer);
  if (error) pending.reject(new Error(error));
  else {
    if ((pending.name === "bridge_configure_mcp" || pending.name === "bridge_remove_mcp" || pending.name === "bridge_install_mysql" || pending.name === "bridge_install_playwright" || pending.name === "bridge_install_builtin_mcp" || pending.name === "bridge_uninstall_mcp") && result && typeof result === "object") {
      const payload = result as { tools?: BrowserTool[]; mcpServers?: BrowserMcpStatus[]; removedServerId?: string };
      if (Array.isArray(payload.tools)) bridge.tools = payload.tools;
      if (Array.isArray(payload.mcpServers)) bridge.mcpServers = payload.mcpServers;
      if (pending.name === "bridge_remove_mcp" && payload.removedServerId) bridge.tools = bridge.tools.filter((tool: BrowserTool) => tool.serverId !== payload.removedServerId);
    }
    pending.resolve(result);
  }
}

async function enqueueBrowserCall(serverId: string, name: string, args: Record<string, unknown>, overrideTimeoutSeconds?: number) {
  const bridge = currentBrowserBridge();
  if (!bridge) throw new Error("本机浏览器未连接。");
  const configuredTimeout = Number(await readUserAppSetting("browser_bridge_call_timeout_seconds"));
  const timeoutSeconds = overrideTimeoutSeconds || (Number.isInteger(configuredTimeout) && configuredTimeout >= 5 && configuredTimeout <= 300 ? configuredTimeout : 30);
  const id = randomUUID();
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      bridge.pending.delete(id);
      const queue = bridge as Bridge & { queue?: Array<{ id: string; serverId: string; name: string; arguments: Record<string, unknown> }> };
      if (queue.queue) queue.queue = queue.queue.filter((call) => call.id !== id);
      reject(new Error("本机 BrowserBridge 工具调用超时。"));
    }, timeoutSeconds * 1000);
    bridge.pending.set(id, { name, resolve, reject, timer });
    const queue = bridge as Bridge & { queue?: Array<{ id: string; serverId: string; name: string; arguments: Record<string, unknown> }> };
    (queue.queue ||= []).push({ id, serverId, name, arguments: args });
  });
}

export function callBrowserTool(serverId: string, name: string, args: Record<string, unknown>) {
  return enqueueBrowserCall(serverId, name, args);
}

export function callBrowserBridgeCommand(name: BrowserBridgeCommand, args: Record<string, unknown>) {
  const longRunning = name.startsWith("bridge_install_") || name === "bridge_uninstall_mcp";
  return enqueueBrowserCall("__bridge__", name, args, longRunning ? 300 : 180);
}
