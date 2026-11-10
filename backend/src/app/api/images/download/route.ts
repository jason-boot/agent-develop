import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { authenticated } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maxImageBytes = 25 * 1024 * 1024;

function publicIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100))
    || (a === 203 && b === 0 && c === 113)
    || (a === 255 && b === 255 && c === 255));
}

function publicIpv6(address: string) {
  let value = address.toLowerCase().split("%")[0];
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    const ipv4 = value.slice(separator + 1);
    if (!publicIpv4(ipv4)) return false;
    const parts = ipv4.split(".").map(Number);
    value = `${value.slice(0, separator)}:${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  if (words.length !== 8) return false;
  const first = Number.parseInt(words[0], 16);
  const second = Number.parseInt(words[1], 16);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return false;
  // Only global unicast (2000::/3) is routable for this download proxy.
  return (first & 0xe000) === 0x2000 && !(first === 0x2001 && second === 0x0db8);
}

function publicAddress(address: string, family: number) {
  return family === 4 ? publicIpv4(address) : family === 6 && publicIpv6(address);
}

async function validatePublicHttpsUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("图片地址无效。"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("只支持 HTTPS 图片地址。");
  const literalFamily = isIP(url.hostname);
  const addresses = literalFamily
    ? [{ address: url.hostname, family: literalFamily }]
    : await lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some((address) => !publicAddress(address.address, address.family))) throw new Error("图片地址必须指向公网服务器。");
  return url;
}

function imageFilename(index: number, mimeType: string) {
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1] || "png";
  return `little-sunshine-generated-${index}.${extension.replace(/[^a-z0-9]/gi, "")}`;
}

function attachmentResponse(bytes: Uint8Array, mimeType: string, index: number) {
  const filename = imageFilename(index, mimeType);
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, { headers: {
    "Content-Type": mimeType,
    "Content-Length": String(bytes.byteLength),
    "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  } });
}

async function readLimited(response: Response) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxImageBytes) throw new Error("图片超过 25 MB，无法下载。");
  if (!response.body) throw new Error("图片服务没有返回文件内容。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxImageBytes) { await reader.cancel(); throw new Error("图片超过 25 MB，无法下载。"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function handlerPOST(request: Request) {
  try {
    const body = await request.json() as { url?: unknown; index?: unknown };
    const imageUrl = typeof body.url === "string" ? body.url : "";
    const index = Number.isInteger(body.index) && Number(body.index) >= 1 && Number(body.index) <= 20 ? Number(body.index) : 1;
    const dataMatch = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(imageUrl);
    if (dataMatch) {
      const bytes = Buffer.from(dataMatch[2], "base64");
      if (bytes.byteLength > maxImageBytes) return Response.json({ error: "图片超过 25 MB，无法下载。" }, { status: 413 });
      return attachmentResponse(bytes, dataMatch[1], index);
    }

    let currentUrl = await validatePublicHttpsUrl(imageUrl);
    let upstream: Response | undefined;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      upstream = await fetch(currentUrl, { redirect: "manual", signal: AbortSignal.timeout(45_000) });
      if (upstream.status < 300 || upstream.status >= 400) break;
      const location = upstream.headers.get("location");
      if (!location || redirects === 3) throw new Error("图片地址重定向过多，无法下载。");
      currentUrl = await validatePublicHttpsUrl(new URL(location, currentUrl).toString());
    }
    if (!upstream?.ok) throw new Error(`图片服务返回 HTTP ${upstream?.status || 502}。`);
    const mimeType = upstream.headers.get("content-type")?.split(";")[0].trim().toLowerCase() || "";
    if (!/^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(mimeType)) throw new Error("图片服务返回的内容不是受支持的图片格式。");
    return attachmentResponse(await readLimited(upstream), mimeType, index);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "下载图片失败。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}

export const POST = authenticated(handlerPOST);
