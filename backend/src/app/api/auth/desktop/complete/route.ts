import { completeDesktopOAuthTicket } from "@/lib/auth";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const ticket = new URL(request.url).searchParams.get("ticket") || "";
  return completeDesktopOAuthTicket(request, ticket);
}
