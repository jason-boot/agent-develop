import { clearSessionCookie, getSession, listOAuthProviders } from "@/lib/auth";
import { listUserIdentities } from "@/lib/local-db";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const user = await getSession(request);
  const identities = user && !user.local ? await listUserIdentities(user.id) : [];
  return Response.json({ user: user ? { id: user.id, username: user.username, local: user.local || false, authProvider: user.authProvider || null, identities } : null, providers: listOAuthProviders() });
}
export function DELETE(request: Request) { return clearSessionCookie(request); }
