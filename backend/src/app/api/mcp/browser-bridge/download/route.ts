import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function compareVersions(left: string, right: string) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function ancestorDirectories(start: string) {
  const result: string[] = [];
  let current = path.resolve(start);
  for (let depth = 0; depth < 6; depth += 1) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

async function findLatestInstaller(roots: string[]) {
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const packages = entries.flatMap((entry) => {
      const match = entry.isDirectory() ? entry.name.match(/^BrowserBridge-EXE-Package-v(\d+(?:\.\d+)+)$/) : null;
      return match ? [{ directory: entry.name, version: match[1] }] : [];
    }).sort((left, right) => compareVersions(right.version, left.version));

    for (const item of packages) {
      const outputDirectory = path.join(root, item.directory, "output");
      const files = await readdir(outputDirectory, { withFileTypes: true }).catch(() => []);
      const installer = files.find((file) => file.isFile() && file.name.toLowerCase().endsWith(".exe"));
      if (installer) return { path: path.join(outputDirectory, installer.name), filename: installer.name };
    }
  }
  return null;
}

async function findFallbackArchive(roots: string[]) {
  for (const root of roots) {
    const publicDirectory = path.join(root, "frontend", "public");
    const files = await readdir(publicDirectory, { withFileTypes: true }).catch(() => []);
    const archives = files.flatMap((file) => {
      const match = file.isFile() ? file.name.match(/^BrowserBridge-Windows-Installer-v(\d+(?:\.\d+)+)\.zip$/i) : null;
      return match ? [{ filename: file.name, version: match[1] }] : [];
    }).sort((left, right) => compareVersions(right.version, left.version));
    if (archives[0]) return { path: path.join(publicDirectory, archives[0].filename), filename: archives[0].filename };
  }
  return null;
}

export async function GET() {
  try {
    const roots = ancestorDirectories(process.cwd());
    const download = await findLatestInstaller(roots) || await findFallbackArchive(roots);
    if (!download) return new Response("BrowserBridge 安装包暂不可用。", { status: 404 });

    const bytes = await readFile(download.path);
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Response(body, { headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename="${download.filename}"; filename*=UTF-8''${encodeURIComponent(download.filename)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return new Response("读取 BrowserBridge 安装包失败。", { status: 500 });
  }
}
