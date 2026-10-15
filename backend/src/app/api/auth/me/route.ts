import { clearSessionCookie, getSession, listDesktopOAuthProviders, listOAuthProviders } from "@/lib/auth";
import { listUserIdentities } from "@/lib/local-db";

export const runtime = "nodejs";
const desktopRuntime = process.env.LITTLE_SUNSHINE_RUNTIME === "desktop";
export async function GET(request: Request) {
  const user = await getSession(request);
  const identities = user && !desktopRuntime && !user.local ? await listUserIdentities(user.id) : [];
  return Response.json({ user: user ? { id: user.id, username: user.username, local: desktopRuntime || user.local || false, authProvider: user.authProvider || null, identities } : null, providers: desktopRuntime ? listDesktopOAuthProviders() : listOAuthProviders(), desktop: desktopRuntime });
}
export function DELETE(request: Request) { return clearSessionCookie(request); }
