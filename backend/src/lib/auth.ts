import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bindUserIdentity, createLocalUser, findUserById, findUserByIdentity, findUserByUsername, withUserContext, type AppUser, type UserIdentity } from "@/lib/local-db";

const sessionCookie = "little_sunshine_session";
const pendingIdentityCookie = "little_sunshine_oauth_pending";
const sessionLifetimeSeconds = 60 * 60 * 24 * 7;
const jwtIssuer = "little-sunshine";

type OAuthProviderConfig = {
  name?: string;
  clientId?: string;
  clientSecret?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  scope?: string;
  callbackUrl?: string;
  tokenRequestFormat?: "json" | "form";
  tokenGrantType?: string;
  userIdField?: string;
  usernameField?: string;
  displayNameField?: string;
  avatarField?: string;
};
type AuthConfig = { jwtSecret?: string; appBaseUrl?: string; providers?: Record<string, OAuthProviderConfig> };
type OAuthProvider = Required<Pick<OAuthProviderConfig, "clientId" | "clientSecret" | "authorizationUrl" | "tokenUrl" | "userInfoUrl" | "scope" | "tokenRequestFormat" | "userIdField" | "usernameField" | "displayNameField" | "avatarField">> & { callbackUrl?: string; tokenGrantType?: string };
type AppSession = { id: number; username: string; tokenVersion: number; local?: boolean };

let cachedAuthConfig: AuthConfig | undefined;
function configDirectory() { return process.env.USAGE_AGENT_CONFIG_DIR || path.join(process.cwd(), ".agent-data"); }
function isConfigPlaceholder(value: string | undefined) { return !value || /^(请填写|请替换|你的域名)/u.test(value.trim()); }

function authConfig(): AuthConfig {
  if (cachedAuthConfig) return cachedAuthConfig;
  const candidates = [...new Set([path.join(configDirectory(), "auth.json"), path.join(process.cwd(), "auth.json"), path.join(process.cwd(), "backend", "auth.json")])];
  for (const configPath of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as AuthConfig;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("配置根节点必须是 JSON 对象");
      cachedAuthConfig = parsed;
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`认证配置文件 ${configPath} 无法读取：${error instanceof Error ? error.message : "配置格式错误"}`);
    }
  }
  cachedAuthConfig = {};
  return cachedAuthConfig;
}

function jwtSecret() {
  const configured = process.env.JWT_SECRET || authConfig().jwtSecret;
  if (configured && !isConfigPlaceholder(configured)) return configured;
  const keyPath = path.join(configDirectory(), "jwt-secret.key");
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  try {
    const key = fs.readFileSync(keyPath, "utf8").trim();
    if (key.length >= 40) return key;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const generated = randomBytes(48).toString("base64url");
  try { fs.writeFileSync(keyPath, generated, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return fs.readFileSync(keyPath, "utf8").trim();
}

function signJwt(input: string) { return createHmac("sha256", jwtSecret()).update(input).digest("base64url"); }
function pendingIdentity(request: Request): UserIdentity | null {
  const token = cookie(request, pendingIdentityCookie);
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const supplied = Buffer.from(signature);
  const expected = Buffer.from(signJwt(payload));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { identity?: UserIdentity; exp?: number };
    if (!value.identity || !Number.isFinite(value.exp) || value.exp! <= Date.now() / 1000) return null;
    return value.identity;
  } catch { return null; }
}
function clearPendingIdentity(response: Response, request: Request) {
  response.headers.append("Set-Cookie", `${pendingIdentityCookie}=; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(request) ? "; Secure" : ""}`);
  return response;
}
async function bindPendingIdentity(request: Request, user: AppUser) {
  const identity = pendingIdentity(request);
  if (identity) await bindUserIdentity(user.id, identity);
}
function secureCookie(request: Request) { return new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https"; }
function redirectResponse(url: URL) { return new Response(null, { status: 302, headers: { Location: url.toString() } }); }
function cookie(request: Request, name: string) {
  return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
function providerConfig(providerId: string): OAuthProvider | null {
  if (!/^[a-z0-9_-]{2,40}$/.test(providerId)) return null;
  const config = authConfig();
  const entry = config.providers?.[providerId];
  if (typeof entry?.clientId !== "string" || !entry.clientId || typeof entry.clientSecret !== "string" || !entry.clientSecret) return null;
  if (isConfigPlaceholder(entry.clientId) || isConfigPlaceholder(entry.clientSecret)) return null;
  const defaults = providerId === "github" ? {
    authorizationUrl: "https://github.com/login/oauth/authorize", tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user", scope: "read:user", tokenRequestFormat: "json" as const,
    userIdField: "id", usernameField: "login", displayNameField: "name", avatarField: "avatar_url",
  } : {};
  const result = { ...defaults, ...entry };
  if (!result.authorizationUrl || !result.tokenUrl || !result.userInfoUrl) throw new Error(`认证配置 ${providerId} 缺少 OAuth authorizationUrl、tokenUrl 或 userInfoUrl。`);
  return {
    clientId: entry.clientId, clientSecret: entry.clientSecret,
    authorizationUrl: result.authorizationUrl, tokenUrl: result.tokenUrl, userInfoUrl: result.userInfoUrl,
    scope: result.scope || "openid profile", callbackUrl: entry.callbackUrl, tokenGrantType: entry.tokenGrantType,
    tokenRequestFormat: result.tokenRequestFormat || "form", userIdField: result.userIdField || "sub",
    usernameField: result.usernameField || "preferred_username", displayNameField: result.displayNameField || "name", avatarField: result.avatarField || "picture",
  };
}

function callbackUrl(request: Request, providerId: string, provider: OAuthProvider) {
  if (provider.callbackUrl) return provider.callbackUrl;
  const appBaseUrl = process.env.APP_BASE_URL || authConfig().appBaseUrl;
  const origin = appBaseUrl || `${request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "")}://${request.headers.get("x-forwarded-host") || request.headers.get("host") || new URL(request.url).host}`;
  return new URL(`/api/auth/oauth/${providerId}/callback`, origin).toString();
}

export function createOAuthLoginUrl(request: Request, providerId: string) {
  const provider = providerConfig(providerId);
  if (!provider) return Response.json({ error: `未配置第三方登录平台：${providerId}` }, { status: 404 });
  const state = randomBytes(32).toString("base64url");
  const authorizeUrl = new URL(provider.authorizationUrl);
  authorizeUrl.searchParams.set("client_id", provider.clientId);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl(request, providerId, provider));
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", provider.scope);
  authorizeUrl.searchParams.set("state", state);
  const response = redirectResponse(authorizeUrl);
  response.headers.append("Set-Cookie", `little_sunshine_oauth_state_${providerId}=${state}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=600${secureCookie(request) ? "; Secure" : ""}`);
  response.headers.append("Set-Cookie", `little_sunshine_oauth_popup_${providerId}=${requestUrlPopup(request) ? "1" : "0"}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=600${secureCookie(request) ? "; Secure" : ""}`);
  return response;
}

function requestUrlPopup(request: Request) { return new URL(request.url).searchParams.get("popup") === "1"; }

function getPathValue(value: unknown, fieldPath: string): unknown {
  return fieldPath.split(".").reduce<unknown>((current, key) => current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, value);
}

function setSessionCookie(response: Response, request: Request, user: AppUser) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: String(user.id), ver: user.tokenVersion, iat: now, exp: now + sessionLifetimeSeconds, iss: jwtIssuer })).toString("base64url");
  const token = `${header}.${payload}.${signJwt(`${header}.${payload}`)}`;
  response.headers.append("Set-Cookie", `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionLifetimeSeconds}${secureCookie(request) ? "; Secure" : ""}`);
  return response;
}

function jsonWithSession(request: Request, user: AppUser) {
  return setSessionCookie(Response.json({ user: { id: user.id, username: user.username } }), request, user);
}

export function clearSessionCookie(request: Request) {
  const response = Response.json({ ok: true });
  response.headers.append("Set-Cookie", `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(request) ? "; Secure" : ""}`);
  return response;
}

export function listOAuthProviders() {
  return Object.entries(authConfig().providers || {}).flatMap(([id, config]) => {
    try { return providerConfig(id) ? [{ id, name: config.name || (id === "github" ? "GitHub" : id === "gitee" ? "Gitee" : id === "google" ? "Google" : id) }] : []; }
    catch { return []; }
  });
}

export async function registerWithPassword(request: Request) {
  const body = await request.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(username)) return Response.json({ error: "用户名需为 3–32 个字母、数字、中文、下划线或连字符。" }, { status: 400 });
  if (password.length < 8 || password.length > 128) return Response.json({ error: "密码长度需为 8–128 个字符。" }, { status: 400 });
  const salt = randomBytes(16).toString("hex");
  const hash = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
  try {
    const user = await createLocalUser(username, hash.toString("hex"), salt);
    try {
      await bindPendingIdentity(request, user);
      return clearPendingIdentity(jsonWithSession(request, user), request);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "第三方账号绑定失败，请重试。" }, { status: 409 });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" || (error as { code?: string }).code === "ER_DUP_ENTRY" || /UNIQUE constraint failed|Duplicate entry/i.test(detail)) return Response.json({ error: "该用户名已被注册。" }, { status: 409 });
    throw error;
  }
}

export async function loginWithPassword(request: Request) {
  const body = await request.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const user = username ? await findUserByUsername(username) : null;
  if (!user || !user.isActive || password.length > 128) return Response.json({ error: "用户名或密码不正确。" }, { status: 401 });
  const hash = await new Promise<Buffer>((resolve, reject) => scrypt(password, user.passwordSalt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
  const expected = Buffer.from(user.passwordHash, "hex");
  if (hash.length !== expected.length || !timingSafeEqual(hash, expected)) return Response.json({ error: "用户名或密码不正确。" }, { status: 401 });
  try {
    await bindPendingIdentity(request, user);
    return clearPendingIdentity(jsonWithSession(request, user), request);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "第三方账号绑定失败，请重试。" }, { status: 409 });
  }
}

function decodeJwt(request: Request) {
  const token = cookie(request, sessionCookie);
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const signingInput = `${parts[0]}.${parts[1]}`;
  const provided = Buffer.from(parts[2]);
  const expected = Buffer.from(signJwt(signingInput));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { alg?: string };
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { sub?: string; ver?: number; exp?: number; iss?: string };
    const id = Number(payload.sub);
    if (header.alg !== "HS256" || payload.iss !== jwtIssuer || !Number.isSafeInteger(id) || id < 1 || !Number.isInteger(payload.ver) || !Number.isFinite(payload.exp) || payload.exp! <= Date.now() / 1000) return null;
    return { id, tokenVersion: payload.ver! };
  } catch { return null; }
}

export async function getSession(request: Request): Promise<AppSession | null> {
  const claims = decodeJwt(request);
  if (!claims) return null;
  const user = await findUserById(claims.id);
  if (!user || !user.isActive || user.tokenVersion !== claims.tokenVersion) return null;
  return { id: user.id, username: user.username, tokenVersion: user.tokenVersion };
}

export async function completeOAuthLogin(request: Request, providerId: string) {
  const provider = providerConfig(providerId);
  if (!provider) return new Response(`未配置第三方平台：${providerId}`, { status: 404 });
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");
  const stateCookieName = `little_sunshine_oauth_state_${providerId}`;
  const popupCookieName = `little_sunshine_oauth_popup_${providerId}`;
  const expectedState = cookie(request, stateCookieName);
  const popup = cookie(request, popupCookieName) === "1";
  const clearState = `${stateCookieName}=; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(request) ? "; Secure" : ""}`;
  const clearPopup = `${popupCookieName}=; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(request) ? "; Secure" : ""}`;
  const redirect = (pathName: string, user?: AppUser) => {
    const appBaseUrl = process.env.APP_BASE_URL || authConfig().appBaseUrl || new URL(callbackUrl(request, providerId, provider)).origin;
    let response: Response;
    if (popup) {
      const resultUrl = new URL(pathName, appBaseUrl);
      const auth = resultUrl.searchParams.get("auth") || (user ? "success" : "failed");
      const message = resultUrl.searchParams.get("message");
      const payload = JSON.stringify({ type: "little-sunshine-oauth", auth, message, provider: providerId }).replace(/</g, "\\u003c");
      const targetOrigin = JSON.stringify(new URL(appBaseUrl).origin);
      response = new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>授权完成</title><body><p>授权完成，正在返回 Little Sunshine…</p><script>if(window.opener){window.opener.postMessage(${payload},${targetOrigin});window.close();}</script></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    } else response = redirectResponse(new URL(pathName, appBaseUrl));
    response.headers.append("Set-Cookie", clearState);
    response.headers.append("Set-Cookie", clearPopup);
    return user ? setSessionCookie(response, request, user) : response;
  };
  if (requestUrl.searchParams.has("error")) return redirect("/?auth=cancelled");
  if (!code || !state || !expectedState || state !== expectedState) return new Response("OAuth state 校验失败，请重新登录。", { status: 400, headers: { "Set-Cookie": clearState } });

  const tokenBody = { ...(provider.tokenGrantType ? { grant_type: provider.tokenGrantType } : {}), client_id: provider.clientId, client_secret: provider.clientSecret, code, redirect_uri: callbackUrl(request, providerId, provider), state };
  const tokenResponse = await fetch(provider.tokenUrl, {
    method: "POST", headers: { Accept: "application/json", "Content-Type": provider.tokenRequestFormat === "json" ? "application/json" : "application/x-www-form-urlencoded" },
    body: provider.tokenRequestFormat === "json" ? JSON.stringify(tokenBody) : new URLSearchParams(tokenBody),
  });
  const tokenData = await tokenResponse.json() as Record<string, unknown>;
  const accessToken = tokenData.access_token;
  if (!tokenResponse.ok || typeof accessToken !== "string") return new Response("第三方平台 token 交换失败。", { status: 502, headers: { "Set-Cookie": clearState } });
  const profileResponse = await fetch(provider.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": "Little-Sunshine" },
  });
  const profile = await profileResponse.json() as unknown;
  const providerUserId = getPathValue(profile, provider.userIdField);
  const providerUsername = getPathValue(profile, provider.usernameField);
  const displayName = getPathValue(profile, provider.displayNameField);
  const avatar = getPathValue(profile, provider.avatarField);
  if (!profileResponse.ok || (typeof providerUserId !== "string" && typeof providerUserId !== "number") || !providerUserId) return new Response("无法读取第三方账号资料。", { status: 502, headers: { "Set-Cookie": clearState } });
  const identity: UserIdentity = {
    provider: providerId, providerUserId: String(providerUserId),
    providerUsername: typeof providerUsername === "string" ? providerUsername.slice(0, 191) : "",
    providerDisplayName: typeof displayName === "string" ? displayName.slice(0, 191) : "",
    avatarUrl: typeof avatar === "string" ? avatar.slice(0, 1000) : "", createdAt: Date.now(),
  };

  const pendingPayload = Buffer.from(JSON.stringify({ identity, exp: Math.floor(Date.now() / 1000) + 10 * 60 })).toString("base64url");
  const setPendingIdentity = (response: Response) => {
    response.headers.append("Set-Cookie", `${pendingIdentityCookie}=${pendingPayload}.${signJwt(pendingPayload)}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=600${secureCookie(request) ? "; Secure" : ""}`);
    return response;
  };

  const currentSession = await getSession(request);
  if (currentSession && !currentSession.local) {
    try {
      await bindUserIdentity(currentSession.id, identity);
      const user = await findUserById(currentSession.id);
      if (!user) return new Response("当前用户不存在。", { status: 401 });
      return redirect("/?auth=provider-bound", user);
    } catch (error) { return redirect(`/?auth=bind-failed&message=${encodeURIComponent(error instanceof Error ? error.message : "绑定失败")}`); }
  }

  const existingUser = await findUserByIdentity(providerId, identity.providerUserId);
  if (existingUser?.isActive) return redirect("/", existingUser);
  return setPendingIdentity(redirect("/?auth=provider-unlinked"));
}

export async function requireApiUser(request: Request, callback: () => Promise<Response>) {
  const session = await getSession(request);
  if (!session) return Response.json({ error: "请先登录。", loginRequired: true }, { status: 401 });
  return withUserContext(session.id, callback);
}

export function authenticated<T extends (request: Request, ...args: any[]) => Promise<Response>>(handler: T): T {
  return (async (request: Request, ...args: any[]) => {
    const session = await getSession(request);
    if (!session) return Response.json({ error: "请先登录。", loginRequired: true }, { status: 401 });
    return withUserContext(session.id, () => handler(request, ...args));
  }) as T;
}
