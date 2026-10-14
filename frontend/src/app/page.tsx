"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatReply, DailyModelUsage, ProjectFileChange, ToolTrace, UsageChartSpec, UsageRecord } from "@little-sunshine/shared/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { diffLines } from "diff";
import { ArrowDown, ArrowUp, ChevronDown, FolderOpen, FolderPlus, LogOut, MoreHorizontal, Paperclip, Pencil, Pin, Plus, Trash2, TriangleAlert, X } from "lucide-react";

type ImageAttachment = { id: string; name: string; mimeType: "image/jpeg" | "image/png" | "image/webp"; dataUrl: string };
type Message = { role: "assistant" | "user"; content: string; images?: ImageAttachment[]; generatedImages?: string[]; result?: ChatReply; projectId?: string; error?: boolean };
type Conversation = { id: string; title: string; updatedAt: number; pinned?: boolean; projectId?: string; projectName?: string; messages?: Message[] };
const sortConversations = (items: Conversation[]) => [...items].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt);
type LocalProject = { id: string; name: string };
type ModelProtocol = "chat" | "messages" | "responses";
type ModelProfile = { id: string; name: string; protocol: ModelProtocol; baseUrl: string; fullAddress: boolean; model: string; vendor: string; modelsUrl: string; hasApiKey: boolean };
type ModelList = { models: ModelProfile[]; defaultModelId: string | null };
type ProviderModelRow = { displayName: string; upstreamModel: string };
type ModelVendor = "aliyun-bailian" | "custom";
type BailianRegion = "beijing" | "singapore" | "hong-kong" | "tokyo" | "frankfurt" | "virginia";
type McpTool = { name: string; title?: string; description?: string; enabled: boolean; readOnly?: boolean; destructive?: boolean; manuallyAllowed?: boolean; canEnable?: boolean };
type ExternalMcpServer = { id: string; name: string; url: string; enabled: boolean; hasToken: boolean };
type StoredProjectDirectory = { id: string; name: string; handle: FileSystemDirectoryHandle; ownerId?: number; storageKey?: string };

async function readApiJson<T>(response: Response): Promise<T> {
  const body = await response.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    const isHtml = response.headers.get("content-type")?.toLowerCase().includes("text/html") || body.trimStart().startsWith("<");
    if (response.status >= 500 || isHtml) {
      throw new Error(`后端服务暂不可用（HTTP ${response.status}），请检查后端是否启动，以及 Nginx 的 /api 转发配置。`);
    }
    throw new Error(`后端返回了无法读取的响应（HTTP ${response.status}）。`);
  }
}

function SunIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></svg>;
}

function openProjectDirectoryDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("dq-copilot-project-directories", 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("directories")) database.createObjectStore("directories", { keyPath: "id" });
      if (!database.objectStoreNames.contains("userDirectories")) database.createObjectStore("userDirectories", { keyPath: "storageKey" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("打开项目目录记录失败。"));
  });
}

async function getStoredProjectDirectories(ownerId: number) {
  const database = await openProjectDirectoryDatabase();
  return new Promise<StoredProjectDirectory[]>((resolve, reject) => {
    const request = database.transaction("userDirectories", "readonly").objectStore("userDirectories").getAll();
    request.onsuccess = () => { const projects = (request.result as StoredProjectDirectory[]).filter((project) => project.ownerId === ownerId); database.close(); resolve(projects); };
    request.onerror = () => { database.close(); reject(request.error || new Error("读取项目目录记录失败。")); };
  });
}

async function getStoredProjectDirectory(ownerId: number, id: string) {
  const database = await openProjectDirectoryDatabase();
  return new Promise<StoredProjectDirectory | undefined>((resolve, reject) => {
    const request = database.transaction("userDirectories", "readonly").objectStore("userDirectories").get(`${ownerId}:${id}`);
    request.onsuccess = () => { const project = request.result as StoredProjectDirectory | undefined; database.close(); resolve(project); };
    request.onerror = () => { database.close(); reject(request.error || new Error("读取项目目录记录失败。")); };
  });
}

async function saveStoredProjectDirectory(ownerId: number, project: StoredProjectDirectory) {
  const database = await openProjectDirectoryDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("userDirectories", "readwrite");
    transaction.objectStore("userDirectories").put({ ...project, ownerId, storageKey: `${ownerId}:${project.id}` });
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error || new Error("保存项目目录记录失败。")); };
    transaction.onabort = () => { database.close(); reject(transaction.error || new Error("保存项目目录记录失败。")); };
  });
}

async function removeStoredProjectDirectory(ownerId: number, id: string) {
  const database = await openProjectDirectoryDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("userDirectories", "readwrite");
    transaction.objectStore("userDirectories").delete(`${ownerId}:${id}`);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error || new Error("删除项目目录记录失败。")); };
    transaction.onabort = () => { database.close(); reject(transaction.error || new Error("删除项目目录记录失败。")); };
  });
}

function ConversationEntry({ conversation, active, disabled, menuOpen, className = "", onOpen, onToggleMenu, onRename, onTogglePin, onDelete }: {
  conversation: Conversation;
  active: boolean;
  disabled: boolean;
  menuOpen: boolean;
  className?: string;
  onOpen: () => void;
  onToggleMenu: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!menuOpen || !moreButtonRef.current) return;
    const rect = moreButtonRef.current.getBoundingClientRect();
    setMenuPosition({ top: Math.min(rect.bottom + 4, window.innerHeight - 88), left: Math.max(8, Math.min(rect.left, window.innerWidth - 148)) });
  }, [menuOpen]);
  return <div className={`conversation-entry${active ? " active" : ""}${menuOpen ? " menu-open" : ""}`} data-conversation-menu>
    <button type="button" className={`conversation-history-item${active ? " active" : ""}${conversation.pinned ? " pinned" : ""} ${className}`} disabled={disabled} title={conversation.title} onClick={onOpen}>{conversation.pinned ? <><span>{conversation.title}</span><Pin aria-label="已置顶" /></> : conversation.title}</button>
    <button ref={moreButtonRef} type="button" className="conversation-more-button" aria-label={`会话“${conversation.title}”的更多操作`} aria-expanded={menuOpen} disabled={disabled} onClick={(event) => { event.stopPropagation(); onToggleMenu(); }}><MoreHorizontal aria-hidden="true" /></button>
    {menuOpen && menuPosition && typeof document !== "undefined" && createPortal(<div className="conversation-item-menu" role="menu" data-conversation-item-menu style={{ position: "fixed", top: menuPosition.top, right: "auto", left: menuPosition.left }}><button type="button" role="menuitem" disabled={disabled} onClick={(event) => { event.stopPropagation(); onRename(); }}><Pencil aria-hidden="true" />重命名</button><button type="button" role="menuitem" disabled={disabled} onClick={(event) => { event.stopPropagation(); onTogglePin(); }}><Pin aria-hidden="true" />{conversation.pinned ? "取消置顶" : "置顶"}</button><button type="button" role="menuitem" disabled={disabled} onClick={(event) => { event.stopPropagation(); onDelete(); }}><Trash2 aria-hidden="true" />删除</button></div>, document.body)}
  </div>;
}

function ProjectMenuButton({ projectName, open, disabled, onToggle, onDelete }: {
  projectName: string;
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPosition({ top: Math.min(rect.bottom + 4, window.innerHeight - 48), left: Math.max(8, Math.min(rect.left, window.innerWidth - 148)) });
  }, [open]);
  return <div className="project-more-wrap" data-project-menu>
    <button ref={buttonRef} type="button" className="project-more-button" aria-label={`项目“${projectName}”的更多操作`} aria-expanded={open} disabled={disabled} onClick={(event) => { event.stopPropagation(); onToggle(); }}><MoreHorizontal aria-hidden="true" /></button>
    {open && position && typeof document !== "undefined" && createPortal(<div className="conversation-item-menu project-item-menu" role="menu" data-project-item-menu style={{ position: "fixed", top: position.top, right: "auto", left: position.left }}><button type="button" role="menuitem" className="project-item-delete" disabled={disabled} onClick={(event) => { event.stopPropagation(); onDelete(); }}><Trash2 aria-hidden="true" />删除项目</button></div>, document.body)}
  </div>;
}

function ToolTraceList({ traces }: { traces: ToolTrace[] }) {
  const grouped = traces.reduce<Array<ToolTrace & { count: number }>>((items, trace) => {
    const previous = items.at(-1);
    if (previous?.tool === trace.tool) {
      previous.count += 1;
    } else items.push({ ...trace, count: 1 });
    return items;
  }, []);

  return <div className="tool-trace">
    <div className="trace-heading"><span className="trace-check">✓</span><strong>执行步骤</strong><span>{grouped.length} 项</span></div>
    {grouped.map((trace, index) => <div className="trace-tool" key={`${trace.tool}-${index}`}>
      <span className="trace-tool-icon">⌘</span>
      <div className="trace-tool-copy"><strong>{trace.label}{trace.count > 1 && <span className="trace-count" aria-label={`连续调用 ${trace.count} 次`}>{trace.count > 99 ? "99+" : trace.count}</span>}</strong><small>{trace.detail}</small></div>
      <em>完成</em>
    </div>)}
  </div>;
}

function ProjectFileDiff({ change }: { change: ProjectFileChange }) {
  const parts = diffLines(change.originalContent ?? "", change.content);
  return <pre className="project-change-diff-code">{parts.flatMap((part, partIndex) => {
    const rows = part.value.match(/[^\n]*\n|[^\n]+$/g) || [];
    return rows.map((row, rowIndex) => {
      const line = row.replace(/\r?\n$/, "");
      const kind = part.added ? "added" : part.removed ? "removed" : "unchanged";
      const sign = part.added ? "+" : part.removed ? "−" : " ";
      return <span className={`project-diff-line ${kind}`} key={`${partIndex}-${rowIndex}`}><span className="project-diff-sign">{sign}</span><span className="project-diff-content">{line || "\u00a0"}</span></span>;
    });
  })}</pre>;
}

const welcome = "你好，我是使用记录助手。可以问我模型调用量、Token 用量、费用、延迟或失败请求。";
const displayCost = (amount: number | string) => "¥" + String(amount);
const formatNumber = (n: number) => new Intl.NumberFormat("zh-CN").format(n || 0);
function bailianModelsUrl(region: BailianRegion, workspaceId: string) {
  const workspace = workspaceId.trim();
  if (region === "singapore") return "https://dashscope-intl.aliyuncs.com/api/v1/models";
  if (region === "hong-kong") return "https://cn-hongkong.dashscope.aliyuncs.com/api/v1/models";
  const endpoints: Record<Exclude<BailianRegion, "singapore" | "hong-kong">, string> = {
    beijing: "cn-beijing.maas.aliyuncs.com",
    tokyo: "ap-northeast-1.maas.aliyuncs.com",
    frankfurt: "eu-central-1.maas.aliyuncs.com",
    virginia: "us-east-1.maas.aliyuncs.com",
  };
  return workspace ? `https://${workspace}.${endpoints[region]}/api/v1/models` : "";
}
function parseBailianLocation(modelsUrl: string): { region: BailianRegion; workspaceId: string } | null {
  try {
    const host = new URL(modelsUrl).hostname;
    if (host === "dashscope-intl.aliyuncs.com") return { region: "singapore", workspaceId: "" };
    if (host === "cn-hongkong.dashscope.aliyuncs.com") return { region: "hong-kong", workspaceId: "" };
    const suffixes: Array<[string, BailianRegion]> = [["cn-beijing.maas.aliyuncs.com", "beijing"], ["ap-northeast-1.maas.aliyuncs.com", "tokyo"], ["eu-central-1.maas.aliyuncs.com", "frankfurt"], ["us-east-1.maas.aliyuncs.com", "virginia"]];
    const match = suffixes.find(([suffix]) => host.endsWith("." + suffix));
    if (!match) return null;
    return { region: match[1], workspaceId: host.slice(0, -(match[0].length + 1)) };
  } catch { return null; }
}
function readImageFile(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return reject(new Error("读取图片失败。"));
      resolve({ id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, name: file.name, mimeType: file.type as ImageAttachment["mimeType"], dataUrl: reader.result });
    };
    reader.onerror = () => reject(new Error("读取图片失败。"));
    reader.readAsDataURL(file);
  });
}
const timeLabel = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short", hour12: false }).format(date);
};
const ignoredProjectDirectories = new Set([".git", "node_modules", ".next", ".next-dev", "dist", "build", "coverage", ".turbo", "vendor", ".cache", ".gradle", ".venv", "venv", "__pycache__", "target", "out", "bin", "obj", "logs"]);
const readableProjectExtensions = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "mdx", "css", "scss", "html", "svg", "yaml", "yml", "toml", "xml", "sql", "py", "go", "rs", "java", "kt", "sh", "txt", "graphql", "gql", "prisma", "vue", "svelte"]);
function isReadableProjectFile(path: string) {
  const name = path.split("/").at(-1) || "";
  if (/^\.env/i.test(name) || /(^|\/)(id_rsa|id_ed25519|credentials|secrets?)(\.|$)/i.test(path)) return false;
  if (["Dockerfile", "Makefile", ".gitignore", ".nvmrc", "LICENSE"].includes(name)) return true;
  return readableProjectExtensions.has(name.split(".").at(-1)?.toLowerCase() || "");
}
async function readProjectSnapshot(root: FileSystemDirectoryHandle) {
  const files: Record<string, string> = {};
  let bytes = 0;
  const maxBytes = 8_000_000;
  async function visit(directory: FileSystemDirectoryHandle, prefix = "") {
    for await (const [name, entry] of directory as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === "directory") {
        if (!ignoredProjectDirectories.has(name)) await visit(entry as FileSystemDirectoryHandle, path);
        continue;
      }
      if (!isReadableProjectFile(path)) continue;
      const file = await (entry as FileSystemFileHandle).getFile();
      const content = await file.text();
      bytes += new TextEncoder().encode(content).byteLength;
      if (bytes > maxBytes) throw new Error("项目可读文本总量超过 8 MB。请关闭不需要分析的项目，或先排除生成文件和大型数据文件。");
      files[path] = content;
    }
  }
  await visit(root);
  return files;
}
async function writeProjectFile(root: FileSystemDirectoryHandle, path: string, content: string) {
  const parts = path.split("/");
  if (!path || path.length > 500 || path.startsWith("/") || parts.some((part) => !part || part === "." || part === ".." || ["__proto__", "prototype", "constructor"].includes(part)) || /^\.env/i.test(path) || parts.some((part) => ignoredProjectDirectories.has(part))) throw new Error(`拒绝写入不安全的项目路径：${path}`);
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
  const file = await directory.getFileHandle(parts.at(-1)!, { create: true });
  const writable = await file.createWritable();
  await writable.write(content);
  await writable.close();
}
async function readCurrentProjectFile(root: FileSystemDirectoryHandle, path: string) {
  const parts = path.split("/");
  let directory = root;
  try {
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    return await (await directory.getFileHandle(parts.at(-1)!)).getFile().then((file) => file.text());
  } catch (e) {
    if (e instanceof DOMException && e.name === "NotFoundError") return undefined;
    throw e;
  }
}
function inlineMarkdown(value: string) {
  return value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return part;
  });
}
function markdownCells(line: string) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}
function MarkdownContent({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  const parts: React.ReactNode[] = [];
  let textStart = 0;
  let index = 0;
  const addText = (start: number, end: number) => {
    const text = lines.slice(start, end).join("\n");
    if (text.trim()) parts.push(<p className="markdown-paragraph" key={`p-${start}`}>{inlineMarkdown(text)}</p>);
  };
  while (index < lines.length - 1) {
    const separator = markdownCells(lines[index + 1]);
    const isTable = lines[index].includes("|") && separator.length > 1 && separator.every((cell) => /^:?-{3,}:?$/.test(cell));
    if (!isTable) { index += 1; continue; }
    addText(textStart, index);
    const headers = markdownCells(lines[index]);
    index += 2;
    const rows: string[][] = [];
    while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
      rows.push(markdownCells(lines[index]));
      index += 1;
    }
    parts.push(<div className="markdown-table-wrap" key={`t-${textStart}`}><table className="markdown-table"><thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}>{inlineMarkdown(cell)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{inlineMarkdown(row[cellIndex] || "")}</td>)}</tr>)}</tbody></table></div>);
    textStart = index;
  }
  addText(textStart, lines.length);
  return <div className="markdown-content">{parts.length ? parts : <p className="markdown-paragraph">{inlineMarkdown(content)}</p>}</div>;
}
function DailyModelTrendChart({ points, chartSpec, from, to }: { points: DailyModelUsage[]; chartSpec: UsageChartSpec; from: string; to: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [downloadError, setDownloadError] = useState("");
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const dates: string[] = [];
  for (let timestamp = start; timestamp <= end; timestamp += 86_400_000) dates.push(new Date(timestamp).toISOString().slice(0, 10));
  const totals = new Map<string, number>();
  for (const point of points) totals.set(point.model_name, (totals.get(point.model_name) || 0) + point.request_count);
  const models = [...totals.keys()].sort((a, b) => (totals.get(b) || 0) - (totals.get(a) || 0)).slice(0, 8);
  if (!dates.length || !models.length) return <div className="daily-trend-empty">所选时间范围内没有调用记录。</div>;
  const values = new Map<string, Map<string, number>>();
  for (const point of points) {
    if (!models.includes(point.model_name)) continue;
    const series = values.get(point.model_name) || new Map<string, number>();
    series.set(point.day, point.request_count);
    values.set(point.model_name, series);
  }
  const width = 860, height = 300, left = 55, right = 20, top = 18, bottom = 40;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maxValue = Math.max(1, ...models.flatMap((name) => dates.map((day) => values.get(name)?.get(day) || 0)));
  const yMax = Math.ceil(maxValue / 4) * 4 || 4;
  const colors = ["#5078d5", "#36a27a", "#e28b45", "#9b6ad0", "#d35d69", "#3b9fb4", "#8b8f34", "#697386"];
  const x = (index: number) => left + (dates.length === 1 ? plotWidth / 2 : index * plotWidth / (dates.length - 1));
  const y = (value: number) => top + plotHeight - value / yMax * plotHeight;
  const labelStep = Math.max(1, Math.ceil(dates.length / 8));
  const slotWidth = plotWidth / dates.length;
  const barGroupWidth = slotWidth * 0.76;
  const barWidth = Math.max(1, barGroupWidth / models.length);
  const downloadChart = async () => {
    const source = svgRef.current;
    if (!source) return;
    setDownloadError("");
    let svgUrl = "";
    try {
      const clone = source.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", String(width * 2));
      clone.setAttribute("height", String(height * 2));
      const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
      style.textContent = ".trend-gridline{stroke:#ececf0;stroke-width:1}.trend-axis-label{fill:#7d7f89;font:11px Arial,'Noto Sans SC',sans-serif}text{font-family:Arial,'Noto Sans SC',sans-serif}";
      clone.insertBefore(style, clone.firstChild);
      const serialized = new XMLSerializer().serializeToString(clone);
      svgUrl = URL.createObjectURL(new Blob([serialized], { type: "image/svg+xml;charset=utf-8" }));
      const image = new Image();
      image.src = svgUrl;
      await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("图表图片生成失败")); });
      const measureCanvas = document.createElement("canvas");
      const measureContext = measureCanvas.getContext("2d");
      if (!measureContext) throw new Error("无法创建图片画布");
      measureContext.font = "11px Arial, sans-serif";
      const legendItems = models.map((name, index) => ({ name, color: colors[index % colors.length], label: `${name}  ${new Intl.NumberFormat("zh-CN").format(totals.get(name) || 0)} 次` }));
      const legendRows: typeof legendItems[] = [[]];
      let rowWidth = 0;
      for (const item of legendItems) {
        const itemWidth = 18 + measureContext.measureText(item.label).width + 24;
        if (rowWidth && rowWidth + itemWidth > width - 32) { legendRows.push([]); rowWidth = 0; }
        legendRows[legendRows.length - 1].push(item);
        rowWidth += itemWidth;
      }
      const headerHeight = 38;
      const legendHeight = 12 + legendRows.length * 22;
      const canvas = document.createElement("canvas");
      canvas.width = width * 2;
      canvas.height = (headerHeight + height + legendHeight) * 2;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建图片画布");
      context.scale(2, 2);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, headerHeight + height + legendHeight);
      context.textBaseline = "middle";
      context.fillStyle = "#303139";
      context.font = "600 14px Arial, 'Noto Sans SC', sans-serif";
      context.fillText(chartSpec.title, 4, 17);
      context.textAlign = "right";
      context.fillStyle = "#777984";
      context.font = "11px Arial, 'Noto Sans SC', sans-serif";
      context.fillText(`${from} 至 ${to}`, width - 4, 17);
      context.textAlign = "left";
      context.drawImage(image, 0, headerHeight, width, height);
      context.font = "11px Arial, sans-serif";
      context.textBaseline = "middle";
      legendRows.forEach((row, rowIndex) => {
        let cursorX = 16;
        const centerY = headerHeight + height + 12 + rowIndex * 22;
        row.forEach((item) => {
          context.beginPath();
          context.arc(cursorX + 4, centerY, 4.5, 0, Math.PI * 2);
          context.fillStyle = item.color;
          context.fill();
          context.fillStyle = "#454650";
          context.fillText(item.label, cursorX + 14, centerY);
          cursorX += 18 + context.measureText(item.label).width + 24;
        });
      });
      const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG 导出失败")), "image/png"));
      const pngUrl = URL.createObjectURL(png);
      const link = document.createElement("a");
      link.href = pngUrl;
      link.download = `${chartSpec.title.replace(/[\\/:*?\"<>|]/g, "_") || "用量趋势"}.png`;
      link.click();
      URL.revokeObjectURL(pngUrl);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "下载图表失败，请重试。");
    } finally {
      if (svgUrl) URL.revokeObjectURL(svgUrl);
    }
  };
  return <section className="daily-trend" aria-label={chartSpec.title}>
    <div className="daily-trend-heading"><strong>{chartSpec.title}</strong><div className="daily-trend-actions"><span>{from} 至 {to}</span><button type="button" className="trend-download" onClick={downloadChart} aria-label="下载图表图片" title="下载 PNG 图片"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v3h14v-3"/></svg></button></div></div>
    <div className="daily-trend-plot"><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${chartSpec.title}，横轴${chartSpec.xAxisLabel}，纵轴${chartSpec.yAxisLabel}`}>
      {[0, 1, 2, 3, 4].map((tick) => { const value = yMax * tick / 4; const yPos = y(value); return <g key={tick}><line x1={left} x2={width - right} y1={yPos} y2={yPos} className="trend-gridline"/><text x={left - 9} y={yPos + 4} textAnchor="end" className="trend-axis-label">{Math.round(value)}</text></g>; })}
      {dates.map((day, index) => index % labelStep === 0 || index === dates.length - 1 ? <text key={day} x={x(index)} y={height - 12} textAnchor="middle" className="trend-axis-label">{day.slice(5)}</text> : null)}
      <text x={left + plotWidth / 2} y={height - 1} textAnchor="middle" className="trend-axis-label">{chartSpec.xAxisLabel}</text>
      <text x="13" y={top + plotHeight / 2} textAnchor="middle" className="trend-axis-label" transform={`rotate(-90 13 ${top + plotHeight / 2})`}>{chartSpec.yAxisLabel}</text>
      {models.map((name, modelIndex) => chartSpec.type === "bar"
        ? <g key={name}>{dates.map((day, dateIndex) => { const value = values.get(name)?.get(day) || 0; const barX = left + dateIndex * slotWidth + (slotWidth - barGroupWidth) / 2 + modelIndex * barWidth; return <rect key={day} x={barX} y={y(value)} width={Math.max(0.8, barWidth - 1)} height={Math.max(0, top + plotHeight - y(value))} rx="1" fill={colors[modelIndex % colors.length]}><title>{`${day} · ${name}: ${value} 次`}</title></rect>; })}</g>
        : <path key={name} d={dates.map((day, index) => `${index ? "L" : "M"}${x(index)},${y(values.get(name)?.get(day) || 0)}`).join(" ")} fill="none" stroke={colors[modelIndex % colors.length]} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"><title>{name}</title></path>)}
    </svg></div>
    {downloadError && <small className="trend-download-error">{downloadError}</small>}
    <div className="daily-trend-legend">{models.map((name, index) => <span key={name}><i style={{ background: colors[index % colors.length] }} />{name}<small>{new Intl.NumberFormat("zh-CN").format(totals.get(name) || 0)} 次</small></span>)}</div>
    {totals.size > models.length && <small className="daily-trend-note">图中展示调用次数最多的 8 个模型。</small>}
  </section>;
}

function ChatApp({ authenticated, userId, username, unboundProviders = [], onRequireLogin, onLogout }: { authenticated: boolean; userId?: number; username?: string; unboundProviders?: Array<{ id: string; name: string }>; onRequireLogin: () => void; onLogout: () => void }) {
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([{ role: "assistant", content: welcome }]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [conversationProjectId, setConversationProjectId] = useState("");
  const [projectConversationMode, setProjectConversationMode] = useState(false);
  const [openConversationMenuId, setOpenConversationMenuId] = useState("");
  const [openProjectMenuId, setOpenProjectMenuId] = useState("");
  const [projectToDelete, setProjectToDelete] = useState<{ id: string; name: string; conversationIds: string[] } | null>(null);
  const [projectDeleting, setProjectDeleting] = useState(false);
  const [conversationToDelete, setConversationToDelete] = useState<Conversation | null>(null);
  const [conversationDeleting, setConversationDeleting] = useState(false);
  const [conversationToRename, setConversationToRename] = useState<Conversation | null>(null);
  const [conversationRenameName, setConversationRenameName] = useState("");
  const [conversationRenaming, setConversationRenaming] = useState(false);
  const [conversationStorageReady, setConversationStorageReady] = useState(false);
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [projectError, setProjectError] = useState("");
  const [projectDirectoryStorageReady, setProjectDirectoryStorageReady] = useState(false);
  const [applyingProjectChanges, setApplyingProjectChanges] = useState(false);
  const [appliedProjectChangeIndexes, setAppliedProjectChangeIndexes] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [models, setModels] = useState<ModelProfile[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [editingModelId, setEditingModelId] = useState("");
  const [modelName, setModelName] = useState("");
  const [modelProviderName, setModelProviderName] = useState("");
  const [vendorOptionsOpen, setVendorOptionsOpen] = useState(false);
  const [vendorSearch, setVendorSearch] = useState("");
  const [modelVendor, setModelVendor] = useState<ModelVendor>("custom");
  const [bailianRegion, setBailianRegion] = useState<BailianRegion>("beijing");
  const [bailianWorkspaceId, setBailianWorkspaceId] = useState("");
  const [modelProtocol, setModelProtocol] = useState<ModelProtocol>("chat");
  const [modelBaseUrl, setModelBaseUrl] = useState("");
  const [modelFullAddress, setModelFullAddress] = useState(false);
  const [modelListUrl, setModelListUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelApiKey, setModelApiKey] = useState("");
  const [modelSaving, setModelSaving] = useState(false);
  const [modelTesting, setModelTesting] = useState(false);
  const [modelFeedback, setModelFeedback] = useState("");
  const [providerModels, setProviderModels] = useState<string[]>([]);
  const [providerModelRows, setProviderModelRows] = useState<ProviderModelRow[]>([{ displayName: "", upstreamModel: "" }]);
  const [providerModelPickerIndex, setProviderModelPickerIndex] = useState<number | null>(null);
  const [providerModelPickerPlacement, setProviderModelPickerPlacement] = useState<"above" | "below">("below");
  const [providerModelSearch, setProviderModelSearch] = useState("");
  const [modelDiscoveryLoading, setModelDiscoveryLoading] = useState(false);
  const [providerConfigLoading, setProviderConfigLoading] = useState(false);
  const [credentialSourceModelId, setCredentialSourceModelId] = useState("");
  const [modelLimitNoticeOpen, setModelLimitNoticeOpen] = useState(false);
  const [modelToDelete, setModelToDelete] = useState<ModelProfile | null>(null);
  const [modelDeleting, setModelDeleting] = useState(false);
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [externalMcpServers, setExternalMcpServers] = useState<ExternalMcpServer[]>([]);
  const [externalMcpTools, setExternalMcpTools] = useState<Record<string, McpTool[]>>({});
  const [externalMcpLoading, setExternalMcpLoading] = useState("");
  const [externalMcpUpdating, setExternalMcpUpdating] = useState("");
  const [externalMcpServerToDelete, setExternalMcpServerToDelete] = useState<ExternalMcpServer | null>(null);
  const [externalMcpError, setExternalMcpError] = useState("");
  const [externalMcpEditorOpen, setExternalMcpEditorOpen] = useState(false);
  const [externalMcpName, setExternalMcpName] = useState("");
  const [externalMcpUrl, setExternalMcpUrl] = useState("");
  const [externalMcpToken, setExternalMcpToken] = useState("");
  const [externalMcpTesting, setExternalMcpTesting] = useState(false);
  const [externalMcpSaving, setExternalMcpSaving] = useState(false);
  const [externalMcpTested, setExternalMcpTested] = useState(false);
  const [externalMcpPreview, setExternalMcpPreview] = useState<McpTool[]>([]);
  const [externalMcpExpandedId, setExternalMcpExpandedId] = useState("");
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const existingVendors = [...new Set(models.map((model) => model.vendor).filter((vendor) => vendor && vendor !== "custom" && vendor !== "aliyun-bailian"))];
  const availableVendors = ["阿里云百炼", "DeepSeek", "智谱AI", ...existingVendors.filter((vendor) => !["deepseek", "智谱ai", "智谱"].includes(vendor.toLocaleLowerCase()))];
  const filteredVendors = availableVendors.filter((vendor) => vendor.toLocaleLowerCase().includes(vendorSearch.trim().toLocaleLowerCase()));
  const canDiscoverModels = Boolean((modelApiKey.trim() || credentialSourceModelId) && modelListUrl.trim());
  const modelGroups = models.reduce<Record<string, ModelProfile[]>>((groups, model) => {
    const vendor = model.vendor || "custom";
    (groups[vendor] ||= []).push(model);
    return groups;
  }, {});
  const modelVendorLabel = (vendor: string) => vendor === "aliyun-bailian" ? "阿里云百炼" : vendor === "custom" ? "自定义厂商" : vendor;
  const messagesRef = useRef(messages);
  const conversationsRef = useRef(conversations);
  const skipNextConversationPersistRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const projectDirectoriesRef = useRef(new Map<string, FileSystemDirectoryHandle>());
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  messagesRef.current = messages;
  conversationsRef.current = conversations;

  useEffect(() => {
    projectDirectoriesRef.current.clear();
    setProjects([]);
    if (!authenticated || !userId) { setProjectDirectoryStorageReady(true); return; }
    setProjectDirectoryStorageReady(false);
    let cancelled = false;
    void getStoredProjectDirectories(userId).then((storedProjects) => {
      if (cancelled) return;
      for (const project of storedProjects) projectDirectoriesRef.current.set(project.id, project.handle);
    }).catch((e) => {
      if (!cancelled) setProjectError(e instanceof Error ? e.message : "读取已保存的项目目录失败。");
    }).finally(() => { if (!cancelled) setProjectDirectoryStorageReady(true); });
    return () => { cancelled = true; };
  }, [authenticated, userId]);

  useEffect(() => {
    if (!authenticated) { setConversationStorageReady(true); return; }
    void (async () => {
      try {
        const response = await fetch("/api/conversations");
        const data = await readApiJson<{ conversations?: Conversation[]; error?: string }>(response);
        if (!response.ok) throw new Error(data.error || "读取会话失败。");
        const saved = data.conversations || [];
        setConversations(saved);
        if (saved.length) {
          const detailResponse = await fetch(`/api/conversations/${encodeURIComponent(saved[0].id)}`);
          const detail = await readApiJson<{ conversation?: Conversation; error?: string }>(detailResponse);
          if (!detailResponse.ok || !detail.conversation) throw new Error(detail.error || "读取会话失败。");
          skipNextConversationPersistRef.current = true;
          setActiveConversationId(detail.conversation.id);
          const activeProjectId = detail.conversation.projectId || "";
          setConversationProjectId(activeProjectId);
          setProjectConversationMode(Boolean(activeProjectId));
          setMessages(detail.conversation.messages || []);
          if (activeProjectId) {
            try {
              const stored = await getStoredProjectDirectory(userId!, activeProjectId);
              if (!stored) throw new Error("请点击“打开本地项目”重新选择并授权当前会话所属的项目目录。");
              const directory = stored.handle;
              const accessHandle = directory as FileSystemDirectoryHandle & { queryPermission?: (descriptor: { mode: "readwrite" }) => Promise<PermissionState> };
              const permission = accessHandle.queryPermission ? await accessHandle.queryPermission({ mode: "readwrite" }) : "prompt";
              if (permission !== "granted") throw new Error("当前项目目录需要重新授权，请点击“打开本地项目”重新打开后继续。");
              const firstEntry = await (directory as unknown as { values: () => AsyncIterator<FileSystemHandle> }).values().next();
              void firstEntry;
              projectDirectoriesRef.current.set(activeProjectId, directory);
              setProjects((items) => items.some((project) => project.id === activeProjectId) ? items : [...items, { id: activeProjectId, name: stored.name }]);
              setSelectedProjectId(activeProjectId);
            } catch (e) {
              setSelectedProjectId("");
              setProjectError(e instanceof DOMException && e.name === "NotFoundError"
                ? "当前项目目录已不存在或已移动，请点击“打开本地项目”重新选择目录。"
                : e instanceof Error ? e.message : "恢复项目目录失败。");
            }
          }
        }
      } catch (e) { setError(e instanceof Error ? e.message : "读取本地会话失败。"); }
      finally { setConversationStorageReady(true); }
    })();
  }, [authenticated]);
  useEffect(() => {
    if (!openConversationMenuId && !openProjectMenuId) return;
    const closeMenuOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || (!event.target.closest("[data-conversation-menu]") && !event.target.closest("[data-project-menu]") && !event.target.closest("[data-conversation-item-menu]") && !event.target.closest("[data-project-item-menu]"))) {
        setOpenConversationMenuId("");
        setOpenProjectMenuId("");
      }
    };
    window.addEventListener("pointerdown", closeMenuOutside);
    return () => window.removeEventListener("pointerdown", closeMenuOutside);
  }, [openConversationMenuId, openProjectMenuId]);
  useEffect(() => {
    if (!authenticated || !conversationStorageReady || !activeConversationId || conversationDeleting || conversationRenaming || projectDeleting) return;
    if (skipNextConversationPersistRef.current) {
      skipNextConversationPersistRef.current = false;
      return;
    }
    const persist = async () => {
      const currentMessages = messagesRef.current;
      if (!currentMessages.some((message) => message.role === "user")) return;
      const storedMessages = currentMessages.map(({ images, result, projectId: _projectId, ...message }) => ({
        ...message,
        ...(result ? { result: (({ projectChanges: _projectChanges, ...safeResult }) => safeResult)(result) } : {}),
        content: images?.length ? [message.content, "“此处是图片”"].filter(Boolean).join("\n") : message.content,
      }));
      const firstUserMessage = storedMessages.find((message) => message.role === "user")?.content || "新会话";
      const generatedTitle = firstUserMessage.length > 32 ? firstUserMessage.slice(0, 32) + "…" : firstUserMessage;
      const title = conversationsRef.current.find((conversation) => conversation.id === activeConversationId)?.title || generatedTitle;
      const storedProjectId = projectConversationMode ? conversationProjectId : "";
      try {
        const response = await fetch(`/api/conversations/${encodeURIComponent(activeConversationId)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, messages: storedMessages, projectId: storedProjectId || null, projectName: projects.find((project) => project.id === storedProjectId)?.name || conversationsRef.current.find((conversation) => conversation.id === activeConversationId)?.projectName || null }),
        });
        const data = await readApiJson<{ error?: string }>(response);
        if (!response.ok) throw new Error(data.error || "保存会话失败。");
        setConversations((items) => sortConversations([{ id: activeConversationId, title, updatedAt: Date.now(), pinned: items.find((item) => item.id === activeConversationId)?.pinned, ...(storedProjectId ? { projectId: storedProjectId, projectName: projects.find((project) => project.id === storedProjectId)?.name || items.find((item) => item.id === activeConversationId)?.projectName } : {}) }, ...items.filter((item) => item.id !== activeConversationId)]));
      } catch (e) { setError(e instanceof Error ? e.message : "保存本地会话失败。"); }
    };
    void persist();
    if (!loading) return;
    const timer = window.setInterval(() => void persist(), 1500);
    return () => window.clearInterval(timer);
  }, [activeConversationId, authenticated, conversationDeleting, conversationProjectId, conversationRenaming, conversationStorageReady, loading, projectConversationMode, projectDeleting, projects]);

  function startNewConversation() {
    if (loading) return;
    setActiveConversationId("");
    setSelectedProjectId("");
    setConversationProjectId("");
    setProjectConversationMode(false);
    setMessages([{ role: "assistant", content: welcome }]);
    setInput("");
    setPendingImages([]);
    setAppliedProjectChangeIndexes([]);
    setError("");
    setProjectError("");
  }

  async function startProjectConversation(projectId: string) {
    if (!authenticated || !userId) { onRequireLogin(); return; }
    if (loading || projectDeleting) return;
    let directory = projectDirectoriesRef.current.get(projectId);
    let stored: StoredProjectDirectory | undefined;
    try {
      if (!directory) {
        stored = await getStoredProjectDirectory(userId, projectId);
        if (!stored) throw new Error("没有找到该项目已保存的目录授权，请点击“打开本地项目”重新选择目录。");
        directory = stored.handle;
      }
      const accessHandle = directory as FileSystemDirectoryHandle & { queryPermission?: (descriptor: { mode: "readwrite" }) => Promise<PermissionState>; requestPermission?: (descriptor: { mode: "readwrite" }) => Promise<PermissionState> };
      let permission = accessHandle.queryPermission ? await accessHandle.queryPermission({ mode: "readwrite" }) : "prompt";
      if (permission !== "granted" && accessHandle.requestPermission) permission = await accessHandle.requestPermission({ mode: "readwrite" });
      if (permission !== "granted") throw new Error("浏览器需要重新授权该项目目录，请点击“打开本地项目”重新选择目录。");
      const firstEntry = await (directory as unknown as { values: () => AsyncIterator<FileSystemHandle> }).values().next();
      void firstEntry;
      projectDirectoriesRef.current.set(projectId, directory);
      const projectName = projects.find((project) => project.id === projectId)?.name || stored?.name || directory.name;
      setProjects((items) => items.some((project) => project.id === projectId) ? items : [...items, { id: projectId, name: projectName }]);
    } catch (e) {
      const message = e instanceof DOMException && e.name === "NotFoundError"
        ? "项目目录已不存在或已移动，请点击“打开本地项目”重新选择目录。"
        : e instanceof Error ? e.message : "恢复项目目录失败。";
      setProjectError(message);
      return;
    }
    setSelectedProjectId(projectId);
    setActiveConversationId("");
    setConversationProjectId(projectId);
    setProjectConversationMode(true);
    setMessages([{ role: "assistant", content: welcome }]);
    setInput("");
    setPendingImages([]);
    setAppliedProjectChangeIndexes([]);
    setError("");
    setProjectError("");
  }

  async function selectProjectDirectory() {
    if (!authenticated || !userId) { onRequireLogin(); return; }
    setProjectError("");
    const showPicker = (window as Window & { showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    if (!window.isSecureContext || !showPicker) {
      setProjectError("当前浏览器不支持本地目录访问，请使用最新版 Chrome 或 Edge，并通过 HTTPS 或 localhost 打开。");
      return;
    }
    try {
      const directory = await showPicker.call(window, { mode: "readwrite" });
      for (const [id, existing] of projectDirectoriesRef.current) {
        if (await directory.isSameEntry(existing)) {
          await saveStoredProjectDirectory(userId, { id, name: projects.find((project) => project.id === id)?.name || directory.name, handle: directory });
          setSelectedProjectId(id);
          setProjectError("");
          return;
        }
      }
      const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `project-${Date.now()}`;
      const sameNameCount = projects.filter((project) => project.name === directory.name).length;
      const name = sameNameCount ? `${directory.name} (${sameNameCount + 1})` : directory.name;
      await saveStoredProjectDirectory(userId, { id, name, handle: directory });
      projectDirectoriesRef.current.set(id, directory);
      setProjects((items) => [...items, { id, name }]);
      setSelectedProjectId(id);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setProjectError(e instanceof Error ? e.message : "打开本地目录失败。");
    }
  }

  async function applyProjectChanges(messageIndex: number, projectId: string | undefined, changes: ProjectFileChange[]) {
    const directory = projectId ? projectDirectoriesRef.current.get(projectId) : undefined;
    if (!directory) { setProjectError("请重新打开生成这些改动时使用的项目目录，再应用代码改动。"); return; }
    setApplyingProjectChanges(true);
    setProjectError("");
    try {
      const accessHandle = directory as FileSystemDirectoryHandle & { requestPermission?: (descriptor: { mode: "readwrite" }) => Promise<PermissionState> };
      const permission = accessHandle.requestPermission ? await accessHandle.requestPermission({ mode: "readwrite" }) : "granted";
      if (permission !== "granted") throw new Error("浏览器未授予项目目录写入权限。");
      for (const change of changes) {
        const currentContent = await readCurrentProjectFile(directory, change.path);
        if (change.operation === "update" && currentContent !== change.originalContent) throw new Error(`${change.path} 在生成改动后已发生变化，请重新发送需求以读取最新文件。`);
        if (change.operation === "create" && currentContent !== undefined) throw new Error(`${change.path} 已在本地存在，请重新发送需求以避免覆盖现有文件。`);
      }
      for (const change of changes) await writeProjectFile(directory, change.path, change.content);
      setAppliedProjectChangeIndexes((indexes) => indexes.includes(messageIndex) ? indexes : [...indexes, messageIndex]);
    } catch (e) {
      setProjectError(e instanceof Error ? e.message : "应用代码改动失败。");
    } finally { setApplyingProjectChanges(false); }
  }

  async function openConversation(conversation: Conversation) {
    if (loading || conversation.id === activeConversationId) return;
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversation.id)}`);
      const data = await readApiJson<{ conversation?: Conversation; error?: string }>(response);
      if (!response.ok || !data.conversation) throw new Error(data.error || "读取会话失败。");
      const openedConversation = data.conversation;
      skipNextConversationPersistRef.current = true;
      setActiveConversationId(openedConversation.id);
      setConversationProjectId(openedConversation.projectId || "");
      setProjectConversationMode(Boolean(openedConversation.projectId));
      setSelectedProjectId(openedConversation.projectId && projects.some((project) => project.id === openedConversation.projectId) ? openedConversation.projectId : "");
      setMessages(openedConversation.messages || []);
      setAppliedProjectChangeIndexes([]);
      setInput("");
      setPendingImages([]);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "读取本地会话失败。"); }
  }

  function requestDeleteConversation(conversation: Conversation) {
    setOpenConversationMenuId("");
    setError("");
    setConversationToDelete(conversation);
  }

  function requestRenameConversation(conversation: Conversation) {
    setOpenConversationMenuId("");
    setError("");
    setConversationToRename(conversation);
    setConversationRenameName(conversation.title);
  }

  async function toggleConversationPin(conversation: Conversation) {
    setOpenConversationMenuId("");
    setError("");
    const pinned = !conversation.pinned;
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversation.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned }) });
      const data = await readApiJson<{ error?: string }>(response);
      if (!response.ok) throw new Error(data.error || "更新置顶状态失败。");
      setConversations((items) => sortConversations(items.map((item) => item.id === conversation.id ? { ...item, pinned } : item)));
    } catch (e) { setError(e instanceof Error ? e.message : "更新置顶状态失败。"); }
  }

  async function confirmRenameConversation() {
    const target = conversationToRename;
    const title = conversationRenameName.trim();
    if (!target || !title || conversationRenaming) return;
    setConversationRenaming(true);
    setError("");
    try {
      const detailResponse = await fetch(`/api/conversations/${encodeURIComponent(target.id)}`);
      const detail = await readApiJson<{ conversation?: Conversation; error?: string }>(detailResponse);
      if (!detailResponse.ok || !detail.conversation) throw new Error(detail.error || "读取会话失败。");
      const stored = detail.conversation;
      const response = await fetch(`/api/conversations/${encodeURIComponent(target.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, messages: stored.messages || [], projectId: stored.projectId || null, projectName: stored.projectName || null }),
      });
      const data = await readApiJson<{ error?: string }>(response);
      if (!response.ok) throw new Error(data.error || "重命名会话失败。");
      setConversations((items) => sortConversations(items.map((item) => item.id === target.id ? { ...item, title, updatedAt: Date.now() } : item)));
      setConversationToRename(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "重命名会话失败。");
    } finally {
      setConversationRenaming(false);
    }
  }

  async function confirmDeleteConversation() {
    const target = conversationToDelete;
    if (!target || conversationDeleting) return;
    setConversationDeleting(true);
    setError("");
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      const data = await readApiJson<{ deleted?: boolean; error?: string }>(response);
      if (!response.ok || !data.deleted) throw new Error(data.error || "删除会话失败。");
      setConversations((items) => items.filter((item) => item.id !== target.id));
      setConversationToDelete(null);
      if (activeConversationId === target.id) {
        setActiveConversationId("");
        setConversationProjectId("");
        setSelectedProjectId("");
        setProjectConversationMode(false);
        setMessages([{ role: "assistant", content: welcome }]);
        setInput("");
        setPendingImages([]);
        setAppliedProjectChangeIndexes([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除会话失败。");
    } finally {
      setConversationDeleting(false);
    }
  }

  function requestDeleteProject(project: { id: string; name: string; conversations: Conversation[] }) {
    setOpenProjectMenuId("");
    setError("");
    setProjectToDelete({ id: project.id, name: project.name, conversationIds: project.conversations.map((conversation) => conversation.id) });
  }

  async function confirmDeleteProject() {
    const target = projectToDelete;
    if (!target || projectDeleting) return;
    setProjectDeleting(true);
    setError("");
    const deletedIds: string[] = [];
    try {
      for (const id of target.conversationIds) {
        const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
        const data = await readApiJson<{ deleted?: boolean; error?: string }>(response);
        if (response.ok && data.deleted) deletedIds.push(id);
        else throw new Error(data.error || `删除项目聊天失败：${id}`);
      }
      if (!userId) throw new Error("请先登录后再管理项目目录。");
      await removeStoredProjectDirectory(userId, target.id);
      setConversations((items) => items.filter((item) => !deletedIds.includes(item.id)));
      projectDirectoriesRef.current.delete(target.id);
      setProjects((items) => items.filter((project) => project.id !== target.id));
      if (selectedProjectId === target.id) setSelectedProjectId("");
      if (activeConversationId && target.conversationIds.includes(activeConversationId)) {
        setActiveConversationId("");
        setConversationProjectId("");
        setProjectConversationMode(false);
        setMessages([{ role: "assistant", content: welcome }]);
        setInput("");
        setPendingImages([]);
        setAppliedProjectChangeIndexes([]);
      }
      setProjectToDelete(null);
    } catch (e) {
      if (deletedIds.length) setConversations((items) => items.filter((item) => !deletedIds.includes(item.id)));
      if (activeConversationId && deletedIds.includes(activeConversationId)) {
        setActiveConversationId("");
        setConversationProjectId("");
        setProjectConversationMode(false);
        setMessages([{ role: "assistant", content: welcome }]);
        setInput("");
        setPendingImages([]);
        setAppliedProjectChangeIndexes([]);
      }
      setProjectToDelete(null);
      setError(e instanceof Error ? e.message : "删除项目失败。");
    } finally {
      setProjectDeleting(false);
    }
  }

  useEffect(() => {
    if (!authenticated) return;
    fetch("/api/models").then(async (response) => {
      const data = await readApiJson<ModelList>(response);
      if (!response.ok) throw new Error("读取模型配置失败");
      setModels(data.models);
      setSelectedModelId(data.defaultModelId || "");
    }).catch(() => setError("读取模型配置失败。"));
  }, [authenticated]);
  useEffect(() => {
    if (providerModelPickerIndex === null) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Element && !event.target.closest(".provider-model-picker")) {
        setProviderModelPickerIndex(null);
        setProviderModelSearch("");
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProviderModelPickerIndex(null);
        setProviderModelSearch("");
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [providerModelPickerIndex]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);

  async function addImageFiles(files: FileList | null) {
    if (!files?.length) return;
    setError("");
    const selected = Array.from(files);
    if (pendingImages.length + selected.length > 4) { setError("每条消息最多添加 4 张图片。"); return; }
    const maxFileBytes = 4 * 1024 * 1024;
    const supportedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (selected.some((file) => !supportedTypes.has(file.type) || file.size > maxFileBytes)) { setError("仅支持不超过 4 MB 的 JPG、PNG 或 WebP 图片。"); return; }
    try {
      const images = await Promise.all(selected.map(readImageFile));
      const next = [...pendingImages, ...images];
      if (next.reduce((size, image) => size + image.dataUrl.length, 0) > 12 * 1024 * 1024) {
        setError("图片总大小过大，请减少图片数量或选择较小的图片。");
        return;
      }
      setPendingImages(next);
    } catch (e) { setError(e instanceof Error ? e.message : "读取图片失败。"); }
  }

  async function submit(question = input) {
    const value = question.trim();
    if ((!value && !pendingImages.length) || loading) return;
    if (!authenticated) { onRequireLogin(); return; }
    const imagesToSend = pendingImages;
    const requestProjectId = selectedProjectId;
    setConversationProjectId(projectConversationMode ? (requestProjectId || conversationProjectId) : "");
    const requestProjectDirectory = requestProjectId ? projectDirectoriesRef.current.get(requestProjectId) : undefined;
    const conversationId = activeConversationId || (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `conversation-${Date.now()}`);
    const previousMessages = messages
      .filter((message) => !message.error && (message.role === "user" || message.role === "assistant"))
      .filter((message) => !(message.role === "assistant" && message.content === welcome))
      .slice(-12);
    const messagesWithImages = new Set<number>();
    let historyImageBudget = 5 * 1024 * 1024;
    for (let index = previousMessages.length - 1; index >= 0; index -= 1) {
      const images = previousMessages[index].images || [];
      const imageLength = images.reduce((sum, image) => sum + image.dataUrl.length, 0);
      if (imageLength && imageLength <= historyImageBudget) {
        messagesWithImages.add(index);
        historyImageBudget -= imageLength;
      }
    }
    const history = previousMessages.map(({ role, content, images }, index) => ({
      role,
      content,
      ...(images?.length && messagesWithImages.has(index) ? { images: images.map(({ mimeType, dataUrl }) => ({ mimeType, dataUrl })) } : {}),
    }));
    setActiveConversationId(conversationId);
    setError(""); setInput(""); setPendingImages([]); if (imageInputRef.current) imageInputRef.current.value = "";
    setMessages((items) => items.length === 1 && items[0].content === welcome ? [{ role: "user", content: value, ...(imagesToSend.length ? { images: imagesToSend } : {}) }] : [...items, { role: "user", content: value, ...(imagesToSend.length ? { images: imagesToSend } : {}) }]); setLoading(true);
    try {
      const projectFiles = requestProjectDirectory ? await readProjectSnapshot(requestProjectDirectory) : undefined;
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: value, images: imagesToSend.map(({ mimeType, dataUrl }) => ({ mimeType, dataUrl })), modelId: selectedModelId || null, history, ...(projectFiles ? { projectFiles } : {}) }) });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok) {
        let apiError = "";
        if (contentType.toLowerCase().includes("json")) {
          try {
            const data = await readApiJson<{ error?: string }>(response);
            apiError = data.error || "";
          } catch { /* Fall back to a readable service error below. */ }
        }
        if (!apiError) {
          apiError = response.status >= 500 || contentType.toLowerCase().includes("text/html")
            ? `后端服务暂不可用（HTTP ${response.status}），请检查后端是否启动，以及 Nginx 的 /api 转发配置。`
            : `聊天请求失败（HTTP ${response.status}）。`;
        }
        throw new Error(apiError);
      }
      if (!contentType.toLowerCase().includes("application/x-ndjson")) {
        throw new Error("后端没有返回聊天数据流，请检查后端服务是否启动，以及 Nginx 是否将 /api 请求转发到后端。");
      }
      if (!response.body) throw new Error("浏览器无法读取流式响应。");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line) as { type: string; token?: string; error?: string; result?: ChatReply };
        const token = event.token || "";
        if (event.type === "token" && token) {
          setMessages((items) => {
            const next = [...items];
            const last = next[next.length - 1];
            if (last?.role === "assistant") next[next.length - 1] = { ...last, content: last.content + token };
            else next.push({ role: "assistant", content: token });
            return next;
          });
        } else if (event.type === "error") throw new Error(event.error || "查询失败");
        else if (event.type === "done" && event.result) {
          completed = true;
          const result = event.result;
          setMessages((items) => {
            const next = [...items];
            const message = result.messageOnly ? { role: "assistant" as const, content: result.answer } : { role: "assistant" as const, content: result.answer, result, ...(result.projectChanges?.length && requestProjectId ? { projectId: requestProjectId } : {}) };
            if (next[next.length - 1]?.role === "assistant") next[next.length - 1] = message;
            else next.push(message);
            return next;
          });
        }
      };
      try {
        while (true) {
          const { value: chunk, done } = await reader.read();
          buffer += decoder.decode(chunk, { stream: !done });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) consumeLine(line);
          if (done) break;
        }
        if (buffer.trim()) consumeLine(buffer);
      } finally { reader.releaseLock(); }
      if (!completed) throw new Error("流式响应意外结束，请重试。");
    } catch (e) {
      const errorMessage = e instanceof TypeError && /fetch/i.test(e.message)
        ? "无法连接到后端服务，请检查后端进程和 Nginx 的 /api 转发配置。"
        : e instanceof Error ? e.message : "查询失败";
      setMessages((items) => {
        const next = items[items.length - 1]?.role === "assistant" ? items.slice(0, -1) : [...items];
        return [...next, { role: "assistant", content: errorMessage, error: true }];
      });
    }
    finally { setLoading(false); }
  }

  async function copyMessage(content: string, index: number) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageIndex(index);
      window.setTimeout(() => setCopiedMessageIndex((current) => current === index ? null : current), 1600);
    } catch {
      setError("复制失败，请检查应用的剪贴板权限。");
    }
  }

  async function persistModelList(response: Response, preferredId?: string) {
    const data = await readApiJson<ModelList & { error?: string }>(response);
    if (!response.ok) throw new Error(data.error || "模型配置操作失败。");
    setModels(data.models);
    const nextId = preferredId || data.defaultModelId || "";
    setSelectedModelId(nextId);
    return data;
  }

  function openModelModal(model?: ModelProfile) {
    setVendorOptionsOpen(false);
    setModelMenuOpen(false);
    setEditingModelId(model?.id || ""); setModelName(model?.name || "");
    setModelVendor(model?.vendor === "aliyun-bailian" ? "aliyun-bailian" : "custom");
    setModelProviderName(model?.vendor === "aliyun-bailian" ? "阿里云百炼" : model && model.vendor !== "custom" ? model.vendor : "");
    setModelProtocol(model?.protocol || "chat");
    setModelFullAddress(model?.fullAddress || false);
    setModelBaseUrl(model?.baseUrl || ""); setModelId(model?.model || "");
    setBailianRegion("beijing"); setBailianWorkspaceId("");
    setModelApiKey(""); setCredentialSourceModelId(""); setModelListUrl(model?.modelsUrl || ""); setModelFeedback(""); setProviderModels([]); setProviderModelPickerIndex(null); setProviderModelSearch(""); setProviderModelRows([{ displayName: model?.name || "", upstreamModel: model?.model || "" }]); setModelModalOpen(true);
  }

  function updateProviderName(value: string) {
    const isBailian = value === "阿里云百炼" || value === "aliyun-bailian";
    const isDeepSeek = value.trim().toLocaleLowerCase() === "deepseek";
    const isZhipu = ["智谱ai", "智谱"].includes(value.trim().toLocaleLowerCase());
    setModelProviderName(isBailian ? "阿里云百炼" : isZhipu ? "智谱AI" : value);
    setModelVendor(isBailian ? "aliyun-bailian" : "custom");
    setProviderModels([]);
    setCredentialSourceModelId("");
    if (isBailian) setModelListUrl(bailianModelsUrl(bailianRegion, bailianWorkspaceId));
    else if (isDeepSeek) setModelListUrl("https://api.deepseek.com/models");
    else if (isZhipu) { setModelBaseUrl("https://open.bigmodel.cn/api/paas/v4"); setModelListUrl("https://open.bigmodel.cn/api/paas/v4/models"); setModelProtocol("chat"); }
    else if (modelVendor === "aliyun-bailian" || ["deepseek", "智谱ai", "智谱"].includes(modelProviderName.trim().toLocaleLowerCase())) setModelListUrl("");
  }

  async function reuseLatestProviderConfig() {
    const vendor = modelVendor === "aliyun-bailian" ? modelVendor : modelProviderName.trim();
    if (!vendor) { setModelFeedback("请先选择或填写厂商。"); return; }
    setProviderConfigLoading(true); setModelFeedback("");
    try {
      const response = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "latest-provider", vendor }) });
      const data = await readApiJson<{ id?: string; vendor?: string; protocol?: ModelProtocol; baseUrl?: string; fullAddress?: boolean; modelsUrl?: string; hasApiKey?: boolean; error?: string }>(response);
      if (!response.ok) throw new Error(data.error || "没有找到该厂商已保存的配置。");
      setCredentialSourceModelId(data.hasApiKey ? data.id || "" : "");
      setModelListUrl(data.modelsUrl || "");
      if (data.vendor === "aliyun-bailian" && data.modelsUrl) {
        const location = parseBailianLocation(data.modelsUrl);
        if (location) { setBailianRegion(location.region); setBailianWorkspaceId(location.workspaceId); }
      }
      if (data.protocol === modelProtocol) {
        setModelBaseUrl(data.baseUrl || ""); setModelFullAddress(Boolean(data.fullAddress));
        setModelFeedback(`已复用该厂商最近配置${data.hasApiKey ? "，API Key 将由本机安全读取" : ""}。`);
      } else {
        setModelFeedback(`已复用模型列表地址${data.hasApiKey ? "和本机保存的 API Key" : ""}；协议不同，未填充 API 地址。`);
      }
      setProviderModels([]);
    } catch (error) { setModelFeedback(error instanceof Error ? error.message : "获取厂商配置失败。"); }
    finally { setProviderConfigLoading(false); }
  }

  async function discoverModels() {
    if (!canDiscoverModels) { setModelFeedback("请先填写 API Key（或复用已保存的 Key）和模型列表 URL，再获取模型列表。"); return; }
    setModelDiscoveryLoading(true); setModelFeedback("");
    try {
      const vendor = modelVendor === "aliyun-bailian" ? modelVendor : modelProviderName.trim();
      const response = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "discover", vendor, modelsUrl: modelListUrl, apiKey: modelApiKey, credentialSourceModelId }) });
      const data = await readApiJson<{ models?: string[]; error?: string }>(response);
      if (!response.ok) throw new Error(data.error || "获取模型列表失败。");
      setProviderModels(data.models || []);
      setProviderModelRows((rows) => rows.length ? rows : [{ displayName: "", upstreamModel: "" }]);
      setModelFeedback("");
    } catch (e) { setModelFeedback(e instanceof Error ? e.message : "获取模型列表失败。"); }
    finally { setModelDiscoveryLoading(false); }
  }

  async function saveProviderModels() {
    setModelSaving(true); setModelFeedback("");
    try {
      const entries = editingModelId ? [{ name: providerModelRows[0]?.displayName || modelName, model: providerModelRows[0]?.upstreamModel || modelId }] : providerModelRows.map((row) => ({ name: row.displayName.trim(), model: row.upstreamModel.trim() })).filter((row) => row.name && row.model);
      if (!entries.length) throw new Error("请至少填写一行模型展示名称和上游模型名。");
      const vendor = modelVendor === "aliyun-bailian" ? modelVendor : modelProviderName.trim();
      const response = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "batch", protocol: modelProtocol, baseUrl: modelBaseUrl, fullAddress: modelFullAddress, apiKey: modelApiKey, credentialSourceModelId, name: modelProviderName, vendor, modelsUrl: modelListUrl, models: entries }) });
      const data = await persistModelList(response);
      const saved = [...data.models].reverse().find((item) => item.baseUrl === (modelFullAddress ? modelBaseUrl.trim() : modelBaseUrl.trim().replace(/\/+$/, "")) && entries.some((entry) => entry.model === item.model));
      if (saved) {
        setSelectedModelId(saved.id);
        await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "default", id: saved.id }) });
      }
      setModelModalOpen(false);
    } catch (e) { setModelFeedback(e instanceof Error ? e.message : "批量保存失败。"); }
    finally { setModelSaving(false); }
  }

  async function saveModel(event: FormEvent) {
    event.preventDefault(); setModelSaving(true); setModelFeedback("");
    try {
      const vendor = modelVendor === "aliyun-bailian" ? modelVendor : modelProviderName.trim();
      const response = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: editingModelId || undefined, name: modelName, protocol: modelProtocol, baseUrl: modelBaseUrl, fullAddress: modelFullAddress, model: modelId, apiKey: modelApiKey, vendor, modelsUrl: modelListUrl }) });
      const data = await persistModelList(response);
      const saved = editingModelId
        ? data.models.find((model) => model.id === editingModelId)
        : [...data.models].reverse().find((model) => model.name === modelName.trim() && model.model === modelId.trim());
      if (saved) {
        setSelectedModelId(saved.id);
        await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "default", id: saved.id }) });
      }
      setModelModalOpen(false);
    } catch (e) { setModelFeedback(e instanceof Error ? e.message : "保存失败。"); }
    finally { setModelSaving(false); }
  }

  async function testModelConnection() {
    setModelTesting(true); setModelFeedback("");
    try {
      const response = await fetch("/api/models/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: editingModelId || undefined, credentialSourceModelId, name: modelName, protocol: modelProtocol, baseUrl: modelBaseUrl, fullAddress: modelFullAddress, model: modelId || providerModelRows[0]?.upstreamModel || "", apiKey: modelApiKey }) });
      const data = await readApiJson<{ error?: string; message?: string }>(response);
      if (!response.ok) throw new Error(data.error || "连接测试失败。");
      setModelFeedback(data.message || "连接成功。");
    } catch (e) { setModelFeedback(e instanceof Error ? e.message : "连接测试失败。"); }
    finally { setModelTesting(false); }
  }

  async function deleteModel(model: ModelProfile) {
    if (models.length <= 1) { setModelLimitNoticeOpen(true); return; }
    setModelMenuOpen(false);
    setModelToDelete(model);
  }

  async function confirmDeleteModel() {
    if (!modelToDelete) return;
    setModelDeleting(true);
    try {
      const response = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", id: modelToDelete.id }) });
      await persistModelList(response);
      setModelToDelete(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败。");
      setModelToDelete(null);
    } finally { setModelDeleting(false); }
  }

  async function chooseModel(id: string) {
    setModelMenuOpen(false);
    setSelectedModelId(id);
    try {
      const response = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "default", id: id || null }) });
      await persistModelList(response, id);
    } catch (e) { setError(e instanceof Error ? e.message : "切换模型失败。"); }
  }

  async function openMcpTools() {
    setMcpModalOpen(true);
    try {
      const serverResponse = await fetch("/api/mcp/servers");
      const serverData = await serverResponse.json() as { servers?: ExternalMcpServer[]; error?: string };
      if (!serverResponse.ok) throw new Error(serverData.error || "读取外部 MCP 配置失败。");
      setExternalMcpServers(serverData.servers || []);
    } catch (e) {
      setExternalMcpError(e instanceof Error ? e.message : "读取外部 MCP 配置失败。");
    }
  }

  function openExternalMcpEditor() {
    setExternalMcpName(""); setExternalMcpUrl(""); setExternalMcpToken("");
    setExternalMcpTested(false); setExternalMcpPreview([]); setExternalMcpError("");
    setExternalMcpEditorOpen(true);
  }

  async function testExternalMcp() {
    setExternalMcpTesting(true); setExternalMcpError(""); setExternalMcpTested(false);
    try {
      const response = await fetch("/api/mcp/servers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "test", url: externalMcpUrl, token: externalMcpToken }) });
      const data = await readApiJson<{ tools?: McpTool[]; error?: string }>(response);
      if (!response.ok) throw new Error(data.error || "MCP 连接测试失败。");
      setExternalMcpPreview(data.tools || []); setExternalMcpTested(true);
    } catch (e) { setExternalMcpError(e instanceof Error ? e.message : "MCP 连接测试失败。"); }
    finally { setExternalMcpTesting(false); }
  }

  async function saveExternalMcp() {
    setExternalMcpSaving(true); setExternalMcpError("");
    try {
      const response = await fetch("/api/mcp/servers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", name: externalMcpName, url: externalMcpUrl, token: externalMcpToken }) });
      const data = await readApiJson<{ server?: ExternalMcpServer; error?: string }>(response);
      if (!response.ok) throw new Error(data.error || "添加 MCP 服务器失败。");
      if (data.server) setExternalMcpServers((items) => [...items, data.server!]);
      setExternalMcpEditorOpen(false);
    } catch (e) { setExternalMcpError(e instanceof Error ? e.message : "添加 MCP 服务器失败。"); }
    finally { setExternalMcpSaving(false); }
  }

  async function loadExternalMcpTools(server: ExternalMcpServer) {
    setExternalMcpLoading(server.id); setExternalMcpError("");
    try {
      const response = await fetch("/api/mcp/servers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "inspect", id: server.id }) });
      const data = await readApiJson<{ tools?: McpTool[]; error?: string }>(response);
      if (!response.ok) throw new Error(data.error || "读取外部 MCP 工具失败。");
      setExternalMcpTools((items) => ({ ...items, [server.id]: data.tools || [] }));
    } catch (e) { setExternalMcpError(e instanceof Error ? e.message : "读取外部 MCP 工具失败。"); }
    finally { setExternalMcpLoading(""); }
  }

  async function toggleExternalMcpServer(server: ExternalMcpServer) {
    setExternalMcpUpdating(server.id); setExternalMcpError("");
    try {
      const response = await fetch("/api/mcp/servers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "toggle-server", id: server.id, enabled: !server.enabled }) });
      const data = await readApiJson<{ enabled?: boolean; error?: string }>(response);
      if (!response.ok) throw new Error(data.error || "更新 MCP 状态失败。");
      setExternalMcpServers((items) => items.map((item) => item.id === server.id ? { ...item, enabled: Boolean(data.enabled) } : item));
    } catch (e) { setExternalMcpError(e instanceof Error ? e.message : "更新 MCP 状态失败。"); }
    finally { setExternalMcpUpdating(""); }
  }

  async function toggleExternalMcpTool(server: ExternalMcpServer, tool: McpTool) {
    const key = server.id + ":" + tool.name;
    setExternalMcpUpdating(key); setExternalMcpError("");
    try {
      const response = await fetch("/api/mcp/servers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "toggle-tool", id: server.id, name: tool.name, enabled: !tool.enabled }) });
      const data = await readApiJson<{ enabled?: boolean; manuallyAllowed?: boolean; error?: string }>(response);
      if (!response.ok) throw new Error(data.error || "更新外部 MCP 工具状态失败。");
      setExternalMcpTools((items) => ({ ...items, [server.id]: (items[server.id] || []).map((item) => item.name === tool.name ? { ...item, enabled: Boolean(data.enabled), manuallyAllowed: Boolean(data.manuallyAllowed) } : item) }));
    } catch (e) { setExternalMcpError(e instanceof Error ? e.message : "更新外部 MCP 工具状态失败。"); }
    finally { setExternalMcpUpdating(""); }
  }

  async function deleteExternalMcpServer(server: ExternalMcpServer) {
    setExternalMcpServerToDelete(server);
  }

  async function confirmDeleteExternalMcpServer() {
    const server = externalMcpServerToDelete;
    if (!server) return;
    setExternalMcpUpdating(server.id); setExternalMcpError("");
    try {
      const response = await fetch("/api/mcp/servers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", id: server.id }) });
      const data = await readApiJson<{ error?: string }>(response);
      if (!response.ok) throw new Error(data.error || "删除 MCP 服务器失败。");
      setExternalMcpServers((items) => items.filter((item) => item.id !== server.id));
      setExternalMcpTools((items) => { const next = { ...items }; delete next[server.id]; return next; });
    } catch (e) { setExternalMcpError(e instanceof Error ? e.message : "删除 MCP 服务器失败。"); }
    finally { setExternalMcpUpdating(""); setExternalMcpServerToDelete(null); }
  }

  const projectConversationGroups = (() => {
    const groups = new Map<string, { id: string; name: string; conversations: Conversation[] }>();
    for (const conversation of conversations) {
      if (!conversation.projectId) continue;
      const group = groups.get(conversation.projectId) || { id: conversation.projectId, name: conversation.projectName || "项目", conversations: [] };
      group.conversations.push(conversation);
      groups.set(group.id, group);
    }
    return [...groups.values()];
  })();
  const recentConversations = conversations.filter((conversation) => !conversation.projectId);
  const showWelcome = messages.length === 1 && messages[0].role === "assistant" && messages[0].content === welcome;

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><SunIcon /></div><div><strong>Little Sunshine</strong></div></div>
      <button className="new-chat" disabled={loading} onClick={startNewConversation}><svg className="new-chat-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg><span>开启新会话</span></button>
      <button type="button" className="new-project" disabled={loading || !projectDirectoryStorageReady} onClick={() => void selectProjectDirectory()}><FolderOpen aria-hidden="true" /><span>打开本地项目(本地文件夹)</span></button>
      {projectConversationGroups.length > 0 && <div className="project-list"><div className="project-list-heading">项目</div>{projectConversationGroups.map((group) => <div className="project-chat-group" key={group.id}><div className="project-list-row"><div className="project-list-select" title={group.name}><FolderPlus aria-hidden="true" /><span>{group.name}</span></div><ProjectMenuButton projectName={group.name} open={openProjectMenuId === group.id} disabled={loading || projectDeleting || conversationDeleting || conversationRenaming} onToggle={() => { setOpenConversationMenuId(""); setOpenProjectMenuId(openProjectMenuId === group.id ? "" : group.id); }} onDelete={() => requestDeleteProject(group)} /><button type="button" className="project-new-chat" aria-label={`在项目 ${group.name} 下新建会话`} title="在此项目下新建会话" disabled={loading || projectDeleting} onClick={() => startProjectConversation(group.id)}><Plus aria-hidden="true" /></button></div>{sortConversations(group.conversations).map((conversation) => <ConversationEntry key={conversation.id} conversation={conversation} active={activeConversationId === conversation.id} disabled={loading || conversationDeleting || conversationRenaming || projectDeleting} menuOpen={openConversationMenuId === conversation.id} className="project-conversation-item" onOpen={() => void openConversation(conversation)} onToggleMenu={() => setOpenConversationMenuId(openConversationMenuId === conversation.id ? "" : conversation.id)} onRename={() => requestRenameConversation(conversation)} onTogglePin={() => void toggleConversationPin(conversation)} onDelete={() => requestDeleteConversation(conversation)} />)}</div>)}</div>}
      {projectError && <div className="project-error" role="alert">{projectError}</div>}
      <div className="conversation-history">
        <div className="conversation-history-heading">最近会话</div>
        {recentConversations.length ? sortConversations(recentConversations).map((conversation) => <ConversationEntry key={conversation.id} conversation={conversation} active={activeConversationId === conversation.id} disabled={loading || conversationDeleting || conversationRenaming} menuOpen={openConversationMenuId === conversation.id} onOpen={() => void openConversation(conversation)} onToggleMenu={() => setOpenConversationMenuId(openConversationMenuId === conversation.id ? "" : conversation.id)} onRename={() => requestRenameConversation(conversation)} onTogglePin={() => void toggleConversationPin(conversation)} onDelete={() => requestDeleteConversation(conversation)} />) : <div className="conversation-history-empty">暂无会话</div>}
      </div>
      <div className="sidebar-bottom">
        {authenticated ? <div className="sidebar-account"><div className="user-chip"><span className="avatar">{username?.slice(0, 1).toUpperCase() || "U"}</span><div className="sidebar-account-name"><strong>{username || "已登录用户"}</strong><small>已登录</small></div><button type="button" className="sidebar-account-more" aria-label="账户菜单" aria-expanded={userMenuOpen} onClick={() => setUserMenuOpen((open) => !open)}><MoreHorizontal aria-hidden="true" /></button></div>{userMenuOpen && <div className="sidebar-account-menu">{unboundProviders.map((provider) => <button type="button" className="sidebar-account-bind" key={provider.id} onClick={() => { window.location.href = `/api/auth/oauth/${encodeURIComponent(provider.id)}`; }}>{`绑定${provider.name}`}</button>)}<button type="button" className="sidebar-account-logout" onClick={() => { setUserMenuOpen(false); onLogout(); }}><LogOut aria-hidden="true" />退出登录</button></div>}</div> : <button type="button" className="guest-sidebar-login" onClick={onRequireLogin}>登录</button>}
      </div>
    </aside>

    <section className="main-area">
      {authenticated && <button type="button" className="mcp-tools-button" onClick={() => void openMcpTools()}><span>☷</span> MCP 工具</button>}
      <div className={"workspace " + (showWelcome ? "welcome-workspace" : "")}>
        <section className={"conversation-panel " + (showWelcome ? "welcome-panel" : "")}>
          <div className={"chat-content " + (showWelcome ? "welcome-content" : "")}>
            {showWelcome ? <div className="welcome-center">
              <h1><span className="welcome-mark"><SunIcon /></span>你好，我是 Little Sunshine</h1>
            </div> : messages.map((message, index) => <div className={"message-row " + message.role} key={index}>
              <div className={"message-avatar " + message.role}>{message.role === "assistant" ? <SunIcon /> : "U"}</div>
              <div className="message-body"><div className="message-meta"><strong>{message.role === "assistant" ? "Little Sunshine" : "你"}</strong><span>{message.role === "assistant" ? "助手" : "刚刚"}</span></div><div className={"bubble " + message.role + (message.error ? " error" : "")}>{message.content && (message.role === "assistant" ? <MarkdownContent content={message.content} /> : message.content)}{message.role === "user" && message.images?.length ? <div className="message-image-list">{message.images.map((image) => <img key={image.id} src={image.dataUrl} alt={image.name || "用户发送的图片"} />)}</div> : null}</div><button type="button" className="message-copy" aria-label={copiedMessageIndex === index ? "已复制" : "复制消息"} title={copiedMessageIndex === index ? "已复制" : "复制消息"} onClick={() => void copyMessage(message.content, index)}>{copiedMessageIndex === index ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2"/></svg>}</button>
                {message.role === "assistant" && message.result?.generatedImages?.length ? <div className="generated-image-list">{message.result.generatedImages.map((image, imageIndex) => <figure key={imageIndex}><a href={image} target="_blank" rel="noreferrer"><img src={image} alt={`模型生成的图片 ${imageIndex + 1}`} /></a><a className="generated-image-download" href={image} download={`little-sunshine-generated-${imageIndex + 1}.png`}>下载图片</a></figure>)}</div> : null}
                {message.result && <>{message.result.dailyModelUsage && message.result.chartSpec && <DailyModelTrendChart points={message.result.dailyModelUsage} chartSpec={message.result.chartSpec} from={message.result.from || ""} to={message.result.to || ""} />}{message.result.showRecords && <><div className="answer-footnote">⌕ 查询范围：{message.result.periodLabel} · 返回 {message.result.records.length} 条记录</div><ChatResultList records={message.result.records} /></>}{message.result.projectChanges?.length ? <section className="project-changes"><div><strong>代码改动</strong><small>{projects.find((project) => project.id === message.projectId)?.name || "项目"} · {message.result.projectChanges.length} 个文件 · 确认后写入本地目录</small></div><details><summary>查看差异</summary>{message.result.projectChanges.map((change) => <section className="project-change-diff" key={change.path}><strong>{change.operation === "create" ? "新增" : "修改"} · {change.path}</strong><ProjectFileDiff change={change} /></section>)}</details><Button type="button" variant="outline" disabled={!message.projectId || !projectDirectoriesRef.current.has(message.projectId) || applyingProjectChanges || appliedProjectChangeIndexes.includes(index)} onClick={() => void applyProjectChanges(index, message.projectId, message.result!.projectChanges!)}>{appliedProjectChangeIndexes.includes(index) ? "已应用" : applyingProjectChanges ? "正在写入…" : "确认并应用改动"}</Button></section> : null}{message.result.trace.length ? <ToolTraceList traces={message.result.trace} /> : null}</>}
              </div></div>)}
            {loading && <div className="message-row assistant"><div className="message-avatar assistant"><SunIcon /></div><div className="bubble assistant typing"><i /><i /><i /></div></div>}
            <div ref={bottomRef} />
          </div>
          <div className={"composer-area " + (showWelcome ? "welcome-composer-area" : "")}><form className="composer" onSubmit={(event: FormEvent) => { event.preventDefault(); void submit(); }}>
            {pendingImages.length > 0 && <div className="composer-image-previews">{pendingImages.map((image) => <div className="composer-image-preview" key={image.id}><img src={image.dataUrl} alt={image.name} /><button type="button" aria-label={`移除图片 ${image.name}`} title="移除图片" onClick={() => setPendingImages((items) => items.filter((item) => item.id !== image.id))}>×</button></div>)}</div>}
            {selectedProject && <div className="project-chat-context active"><FolderPlus aria-hidden="true" /><span>项目</span><span className="project-context-value">{selectedProject.name}</span><small>本轮可访问此项目</small></div>}
            <Textarea className="composer-textarea" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} placeholder="给 Little Sunshine 发送消息" rows={1} />
            <div className="composer-tools"><span className="composer-hint">↵ 发送 · Shift + Enter 换行</span><div className="composer-model-tools"><input ref={imageInputRef} className="image-file-input" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={!authenticated} onChange={(event) => { void addImageFiles(event.target.files); event.target.value = ""; }} /><Button type="button" variant="ghost" size="icon" className="attach-image-button" aria-label="上传图片" data-tooltip="上传图片（最多 4 张，每张不超过 4 MB）" disabled={!authenticated || loading || pendingImages.length >= 4} onClick={() => imageInputRef.current?.click()}><Paperclip aria-hidden="true" /></Button><Popover open={modelMenuOpen} onOpenChange={setModelMenuOpen}><PopoverTrigger asChild><Button type="button" variant="outline" className="model-select-wrap" aria-label="选择聊天模型" aria-haspopup="dialog" aria-expanded={modelMenuOpen} disabled={!authenticated}><span>◈</span><strong>{selectedModel ? selectedModel.name : "未选择模型"}</strong><ArrowDown aria-hidden="true" className="model-trigger-chevron" /></Button></PopoverTrigger>{modelMenuOpen && <PopoverContent side="top" align="start" sideOffset={8} className="model-dropdown" role="menu" aria-label="选择模型"><div className="model-dropdown-heading"><span>选择模型</span><Button type="button" variant="ghost" size="sm" className="model-dropdown-add" role="menuitem" onClick={() => { setModelMenuOpen(false); openModelModal(); }}><Plus aria-hidden="true" />添加自定义模型</Button></div>{Object.entries(modelGroups).map(([vendor, vendorModels]) => <div className="model-dropdown-group" key={vendor}><div className="model-dropdown-group-heading">{modelVendorLabel(vendor)}</div>{vendorModels.map((model) => <div className={`model-dropdown-row ${selectedModelId === model.id ? "selected" : ""}`} key={model.id}><Button type="button" variant="ghost" className="model-option-main" role="menuitemradio" aria-checked={selectedModelId === model.id} onClick={() => void chooseModel(model.id)}><span><strong>{model.name}</strong><small>{model.model} · {model.protocol.toUpperCase()}</small></span></Button><div className="model-option-actions"><Button type="button" variant="ghost" size="icon" className="model-action-button" title={`编辑 ${model.name}`} aria-label={`编辑 ${model.name}`} onClick={() => openModelModal(model)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg></Button><Button type="button" variant="ghost" size="icon" className="model-action-button delete" title={`删除 ${model.name}`} aria-label={`删除 ${model.name}`} onClick={() => void deleteModel(model)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg></Button></div></div>)}</div>)}</PopoverContent>}</Popover><Button type="submit" variant="default" size="icon" className="composer-send-button" disabled={(!input.trim() && pendingImages.length === 0) || loading} aria-label="发送"><ArrowUp aria-hidden="true" /></Button></div></div>
          </form>{error && <div className="error-banner">{error}<button onClick={() => setError("")}>×</button></div>}</div>
        </section>

      </div>
    </section>
    <Dialog open={mcpModalOpen} onOpenChange={setMcpModalOpen}>
      <DialogContent className="mcp-tools-modal flex max-h-[min(88vh,720px)] w-[min(100%,560px)] flex-col gap-0 overflow-hidden rounded-[13px] border border-[#e8e7ed] bg-white p-[23px] text-zinc-900 shadow-[0_22px_70px_#25212d38] sm:max-w-none" showCloseButton={false} aria-labelledby="mcp-tools-title">
      <header><div><DialogTitle id="mcp-tools-title">外部 MCP 管理</DialogTitle><p>管理模型可调用的外部工具服务器。</p></div><DialogClose asChild><button type="button" className="model-modal-close" aria-label="关闭">×</button></DialogClose></header>
      <div className="external-mcp-tab">
        <div className="external-mcp-toolbar"><span>未标记只读的工具需要你手动授权；声明为有破坏性的工具仍不可用。</span><Button type="button" variant="outline" size="sm" onClick={openExternalMcpEditor}><Plus aria-hidden="true" />添加 MCP</Button></div>
        {externalMcpError && <div role="alert" className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{externalMcpError}</div>}
        {externalMcpServers.length ? <div className="mcp-tools-list">{externalMcpServers.map((server) => <Card className="mcp-tool-card external-mcp-card" key={server.id}>
          <div className="mcp-tool-card-heading"><div className="external-mcp-server-title"><strong>{server.name}</strong><small>{server.hasToken ? "已配置认证" : "未配置认证"}</small></div><div className="external-mcp-server-actions"><Switch checked={server.enabled} aria-label={`${server.enabled ? "禁用" : "启用"}服务器 ${server.name}`} title={server.enabled ? "服务器已启用" : "服务器已禁用"} disabled={externalMcpUpdating === server.id} onCheckedChange={() => void toggleExternalMcpServer(server)} /><Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground hover:bg-red-50 hover:text-red-600" title={`删除 ${server.name}`} aria-label={`删除 ${server.name}`} onClick={() => void deleteExternalMcpServer(server)}><Trash2 aria-hidden="true" /></Button></div></div>
          <code>{server.url}</code><Button type="button" variant="ghost" size="sm" className="external-mcp-show-tools h-7 w-fit justify-start px-0 text-[11px]" onClick={() => { if (externalMcpExpandedId === server.id) setExternalMcpExpandedId(""); else { setExternalMcpExpandedId(server.id); if (!externalMcpTools[server.id]) void loadExternalMcpTools(server); } }}>{externalMcpExpandedId === server.id ? "收起工具" : "查看工具"}</Button>
          {externalMcpExpandedId === server.id && <div className="external-mcp-tool-list">{externalMcpLoading === server.id ? <small>正在读取工具…</small> : (externalMcpTools[server.id] || []).length ? externalMcpTools[server.id].map((tool) => <div className="external-mcp-tool" key={tool.name}><div><strong>{tool.title || tool.name}</strong><small>{tool.destructive ? "服务器标记为有破坏性，已禁止" : tool.readOnly ? tool.description || tool.name : tool.manuallyAllowed ? `已手动授权 · ${tool.description || tool.name}` : `未标记为只读 · ${tool.description || tool.name}`}</small></div>{tool.canEnable ? <Switch checked={tool.enabled} aria-label={`${tool.enabled ? "禁用" : tool.readOnly ? "启用" : "手动授权并启用"}${tool.title || tool.name}`} title={tool.readOnly ? (tool.enabled ? "禁用工具" : "启用工具") : (tool.enabled ? "撤销授权并禁用" : "手动授权并启用")} disabled={externalMcpUpdating === server.id + ":" + tool.name} onCheckedChange={() => void toggleExternalMcpTool(server, tool)} /> : <span className="external-mcp-unsafe">不可用</span>}</div>) : <small>服务器没有提供工具。</small>}</div>}
        </Card>)}</div> : <div className="mcp-tools-state">还没有外部 MCP 服务器，点击“添加 MCP”开始配置。</div>}
      </div>
      </DialogContent>
    </Dialog>
    <Dialog open={externalMcpEditorOpen} onOpenChange={setExternalMcpEditorOpen}>
      <DialogContent className="max-h-[90vh] max-w-[500px] overflow-y-auto border-zinc-200 bg-white p-6 text-zinc-900 shadow-2xl sm:max-w-[500px]" showCloseButton={false}>
        <div className="flex items-start justify-between gap-4">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle className="text-xl font-semibold tracking-tight">添加外部 MCP</DialogTitle>
            <DialogDescription>连接外部服务器并检查只读工具。</DialogDescription>
          </DialogHeader>
          <DialogClose asChild><Button type="button" variant="ghost" size="icon" className="-mr-2 -mt-2 size-8 rounded-none border-0 bg-transparent p-0 text-zinc-500 shadow-none outline-none hover:bg-transparent hover:text-zinc-900 focus-visible:border-transparent focus-visible:bg-transparent focus-visible:outline-none focus-visible:ring-0" aria-label="关闭"><X className="size-4" /></Button></DialogClose>
        </div>
        <div className="space-y-4">
          <div className="space-y-2"><Label htmlFor="external-mcp-name">名称</Label><Input id="external-mcp-name" value={externalMcpName} onChange={(event) => { setExternalMcpName(event.target.value); setExternalMcpTested(false); }} placeholder="例如：项目文档 MCP" /></div>
          <div className="space-y-2"><Label htmlFor="external-mcp-url">服务器 URL</Label><Input id="external-mcp-url" value={externalMcpUrl} onChange={(event) => { setExternalMcpUrl(event.target.value); setExternalMcpTested(false); }} placeholder="https://example.com/mcp" /></div>
          <div className="space-y-2"><Label htmlFor="external-mcp-token">Bearer Token（可选）</Label><Input id="external-mcp-token" type="password" autoComplete="new-password" value={externalMcpToken} onChange={(event) => { setExternalMcpToken(event.target.value); setExternalMcpTested(false); }} placeholder="需要认证时填写" /></div>
          <p className="text-xs leading-relaxed text-muted-foreground">访问令牌保存在本机配置文件中，不会返回到页面。只读限制会拒绝未声明为只读的工具。</p>
          {externalMcpError && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{externalMcpError}</div>}
          {externalMcpTested && <div className="space-y-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"><strong>连接成功</strong><p>{externalMcpPreview.filter((tool) => tool.readOnly).length} 个只读工具可直接启用</p>{externalMcpPreview.some((tool) => !tool.readOnly) && <small className="text-amber-700">{externalMcpPreview.filter((tool) => !tool.readOnly && tool.canEnable).length} 个未标记只读的工具可在添加后手动授权；{externalMcpPreview.filter((tool) => tool.destructive).length} 个声明为有破坏性的工具不可用。</small>}</div>}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={externalMcpTesting || !externalMcpUrl.trim()} onClick={() => void testExternalMcp()}>{externalMcpTesting ? "测试中…" : "测试连接"}</Button>
          <Button type="button" disabled={externalMcpSaving || !externalMcpTested || !externalMcpName.trim()} onClick={() => void saveExternalMcp()}>{externalMcpSaving ? "添加中…" : "添加 MCP"}</Button>
        </div>
      </DialogContent>
    </Dialog>
    {modelLimitNoticeOpen && <div className="model-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModelLimitNoticeOpen(false); }}><section className="model-modal model-limit-dialog" role="alertdialog" aria-modal="true" aria-labelledby="model-limit-title" aria-describedby="model-limit-description"><div className="model-limit-icon">!</div><h2 id="model-limit-title">无法删除模型</h2><p id="model-limit-description">至少要保留一个模型。</p><div className="model-modal-actions"><button type="button" className="model-primary-button" onClick={() => setModelLimitNoticeOpen(false)}>我知道了</button></div></section></div>}
    <AlertDialog open={projectToDelete !== null} onOpenChange={(open) => { if (!open && !projectDeleting) setProjectToDelete(null); }}>
      <AlertDialogContent size="sm" className="border-zinc-200 bg-white">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2"><TriangleAlert className="size-4 text-red-500" aria-hidden="true" />删除项目</AlertDialogTitle>
          <AlertDialogDescription>项目“{projectToDelete?.name}”下所有聊天将会一并删除，确认删除吗？本地项目文件不会被删除。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={projectDeleting}>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={projectDeleting} onClick={(event) => { event.preventDefault(); void confirmDeleteProject(); }}>{projectDeleting ? "删除中…" : "确认删除"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <Dialog open={conversationToRename !== null} onOpenChange={(open) => { if (!open && !conversationRenaming) setConversationToRename(null); }}>
      <DialogContent className="max-w-[420px] border-zinc-200 bg-white text-zinc-900">
        <DialogHeader>
          <DialogTitle>重命名会话</DialogTitle>
          <DialogDescription>输入新的会话名称。</DialogDescription>
        </DialogHeader>
        <Input autoFocus maxLength={200} value={conversationRenameName} onChange={(event) => setConversationRenameName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && conversationRenameName.trim() && !conversationRenaming) { event.preventDefault(); void confirmRenameConversation(); } }} placeholder="会话名称" />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={conversationRenaming} onClick={() => setConversationToRename(null)}>取消</Button>
          <Button type="button" disabled={!conversationRenameName.trim() || conversationRenaming} onClick={() => void confirmRenameConversation()}>{conversationRenaming ? "保存中…" : "保存"}</Button>
        </div>
      </DialogContent>
    </Dialog>
    <AlertDialog open={conversationToDelete !== null} onOpenChange={(open) => { if (!open && !conversationDeleting) setConversationToDelete(null); }}>
      <AlertDialogContent size="sm" className="border-zinc-200 bg-white">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2"><TriangleAlert className="size-4 text-red-500" aria-hidden="true" />删除会话</AlertDialogTitle>
          <AlertDialogDescription>确定删除“{conversationToDelete?.title}”吗？删除后无法撤销。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={conversationDeleting}>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={conversationDeleting} onClick={(event) => { event.preventDefault(); void confirmDeleteConversation(); }}>{conversationDeleting ? "删除中…" : "删除会话"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={modelToDelete !== null} onOpenChange={(open) => { if (!open && !modelDeleting) setModelToDelete(null); }}>
      <AlertDialogContent size="sm" className="border-zinc-200 bg-white">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2"><TriangleAlert className="size-4 text-red-500" aria-hidden="true" />删除模型</AlertDialogTitle>
          <AlertDialogDescription>确定删除模型“{modelToDelete?.name}”吗？删除后无法撤销。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={modelDeleting}>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={modelDeleting} onClick={(event) => { event.preventDefault(); void confirmDeleteModel(); }}>{modelDeleting ? "删除中…" : "删除模型"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={externalMcpServerToDelete !== null} onOpenChange={(open) => { if (!open && externalMcpUpdating !== externalMcpServerToDelete?.id) setExternalMcpServerToDelete(null); }}>
      <AlertDialogContent size="sm" className="border-zinc-200 bg-white">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2"><TriangleAlert className="size-4 text-red-500" aria-hidden="true" />删除 MCP 服务器</AlertDialogTitle>
          <AlertDialogDescription>确定删除 MCP 服务器“{externalMcpServerToDelete?.name}”吗？删除后无法撤销。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={externalMcpUpdating === externalMcpServerToDelete?.id}>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={externalMcpUpdating === externalMcpServerToDelete?.id} onClick={(event) => { event.preventDefault(); void confirmDeleteExternalMcpServer(); }}>{externalMcpUpdating === externalMcpServerToDelete?.id ? "删除中…" : "删除服务器"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <Dialog open={modelModalOpen} onOpenChange={setModelModalOpen}>
      <DialogContent className="max-h-[90vh] max-w-[600px] overflow-hidden border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl sm:max-w-[600px]" showCloseButton={false}>
        <section className="flex max-h-[90vh] flex-col">
          <header className="flex items-center justify-between px-6 pt-5 pb-2">
            <DialogHeader className="space-y-1">
              <DialogTitle className="text-xl font-semibold tracking-tight">{editingModelId ? "编辑模型配置" : "添加模型"}</DialogTitle>
            </DialogHeader>
            <DialogClose asChild><Button type="button" variant="ghost" size="icon" className="-mr-2 size-8 rounded-none border-0 bg-transparent p-0 text-zinc-500 shadow-none outline-none hover:bg-transparent hover:text-zinc-900 focus-visible:border-transparent focus-visible:bg-transparent focus-visible:outline-none focus-visible:ring-0" aria-label="关闭"><X className="size-4" /></Button></DialogClose>
          </header>
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); if (editingModelId) void saveModel(event); else void saveProviderModels(); }}>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pt-2 pb-5">
              <div className="space-y-2">
                <Label htmlFor="model-protocol">协议</Label>
                <Select value={modelProtocol} onValueChange={(value) => { setModelProtocol(value as ModelProtocol); setProviderModels([]); }}>
                  <SelectTrigger id="model-protocol" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="chat">Chat · Chat Completions</SelectItem><SelectItem value="messages">Messages · Anthropic</SelectItem><SelectItem value="responses">Responses · OpenAI</SelectItem></SelectContent>
                </Select>
              </div>
        {editingModelId ? <div className="space-y-2"><Label htmlFor="model-display-name">模型展示名称</Label><Input id="model-display-name" required value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder="模型在页面中的展示名称" /></div> : <>
          <div className="provider-config-row"><div className="provider-vendor-picker"><Label htmlFor="model-vendor-input">厂商</Label><Input id="model-vendor-input" className="mt-1" required autoComplete="off" value={modelProviderName} onFocus={() => { setVendorSearch(""); setVendorOptionsOpen(true); }} onClick={() => { if (!vendorOptionsOpen) { setVendorSearch(""); setVendorOptionsOpen(true); } }} onBlur={() => window.setTimeout(() => setVendorOptionsOpen(false), 120)} onChange={(event) => { setVendorSearch(event.target.value); updateProviderName(event.target.value); }} placeholder="输入或选择厂商" />{vendorOptionsOpen && filteredVendors.length > 0 && <div className="provider-vendor-options" role="listbox" aria-label="已有厂商">{filteredVendors.map((vendor) => <button key={vendor} type="button" role="option" aria-selected={modelProviderName === vendor} onMouseDown={(event) => event.preventDefault()} onClick={() => { updateProviderName(vendor); setVendorSearch(""); setVendorOptionsOpen(false); }}>{vendor}</button>)}</div>}</div><Button type="button" variant="outline" size="sm" className="h-[38px] shrink-0 rounded-md border border-zinc-200 bg-white px-3 text-xs text-zinc-600 shadow-none hover:bg-zinc-50 hover:text-zinc-900" disabled={providerConfigLoading || !modelProviderName.trim()} onClick={() => void reuseLatestProviderConfig()}>{providerConfigLoading ? "读取中…" : "复用最近配置"}</Button></div>
          {modelVendor === "aliyun-bailian" ? <>
            <div className="space-y-2"><Label htmlFor="bailian-region">百炼地域</Label><Select value={bailianRegion} onValueChange={(value) => { const region = value as BailianRegion; setBailianRegion(region); setModelListUrl(bailianModelsUrl(region, bailianWorkspaceId)); }}><SelectTrigger id="bailian-region" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="beijing">华北 2（北京）</SelectItem><SelectItem value="singapore">新加坡</SelectItem><SelectItem value="hong-kong">中国香港</SelectItem><SelectItem value="tokyo">日本（东京）</SelectItem><SelectItem value="frankfurt">德国（法兰克福）</SelectItem><SelectItem value="virginia">美国（弗吉尼亚）</SelectItem></SelectContent></Select></div>
            {!(["singapore", "hong-kong"] as BailianRegion[]).includes(bailianRegion) && <div className="space-y-2"><Label htmlFor="bailian-workspace-id">百炼业务空间 ID</Label><Input id="bailian-workspace-id" required value={bailianWorkspaceId} onChange={(event) => { setBailianWorkspaceId(event.target.value); setModelListUrl(bailianModelsUrl(bailianRegion, event.target.value)); }} placeholder="填写 Workspace ID" /></div>}
          </> : null}
        </>}
        <div className="model-address-field"><div className="model-address-heading"><Label htmlFor="model-api-address">API 地址</Label><label className="full-address-toggle"><input type="checkbox" checked={modelFullAddress} onChange={(event) => { setModelFullAddress(event.target.checked); setProviderModels([]); }} /><span className="full-address-switch" /><span>输入完整地址</span></label></div><Input id="model-api-address" required value={modelBaseUrl} onChange={(event) => { setModelBaseUrl(event.target.value); setProviderModels([]); }} placeholder={modelFullAddress ? modelProtocol === "messages" ? "https://api.anthropic.com/v1/messages" : modelProtocol === "responses" ? "https://api.openai.com/v1/responses" : "https://api.openai.com/v1/chat/completions" : modelProtocol === "messages" ? "https://api.anthropic.com" : "https://api.openai.com/v1"} /><small>{modelFullAddress ? "将直接请求填写的完整 URL。" : "填写服务根地址，程序会按所选协议补全接口路径。"}</small></div>
        <div className="space-y-2"><Label htmlFor="model-api-key">API Key</Label><Input id="model-api-key" type="password" autoComplete="new-password" value={modelApiKey} onChange={(event) => { setModelApiKey(event.target.value); setProviderModels([]); }} placeholder={editingModelId ? "留空以保留已保存的 Key" : credentialSourceModelId ? "已关联最近配置的 Key，留空即可复用" : "输入 API Key"} />{editingModelId && <p className="text-xs text-muted-foreground">已保存的 Key 不会回传到页面；留空即可保留。</p>}{!editingModelId && credentialSourceModelId && <p className="text-xs text-muted-foreground">密钥仅在本机服务端读取，不会返回到页面。</p>}</div>
        {!editingModelId && <div className="space-y-2"><Label htmlFor="model-list-url">模型列表 URL（选填）</Label><Input id="model-list-url" type="url" readOnly={modelVendor === "aliyun-bailian"} value={modelListUrl} onChange={(event) => { setModelListUrl(event.target.value); setProviderModels([]); }} placeholder={modelVendor === "aliyun-bailian" ? "根据所选地域自动生成" : "没有模型列表接口可留空"} /><p className="text-xs text-muted-foreground">{modelVendor === "aliyun-bailian" ? "根据官方地域和业务空间 ID 自动配置百炼模型目录接口；其他厂商没有此接口时可留空。" : "选填；填写后可用 API Key 获取模型列表，也可以直接手动填写模型。"}</p></div>}
        {editingModelId ? <div className="space-y-2"><Label htmlFor="model-id-input">上游模型名</Label><Input id="model-id-input" required value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="服务商提供的模型 ID" /></div> : <section className="provider-model-list"><div className="provider-model-list-heading"><strong>模型列表</strong><Button type="button" variant="outline" size="sm" disabled={modelDiscoveryLoading || !canDiscoverModels} onClick={() => void discoverModels()}>{modelDiscoveryLoading ? "正在获取…" : "获取模型列表"}</Button></div><div className="provider-model-row-heading" aria-hidden="true"><span>展示名称</span><span>上游模型名</span><span>选择已获取模型</span><span>操作</span></div>{providerModelRows.map((row, index) => <div className="provider-model-row" key={index}><Input aria-label="模型展示名称" value={row.displayName} onChange={(event) => setProviderModelRows((rows) => rows.map((item, itemIndex) => itemIndex === index ? { ...item, displayName: event.target.value } : item))} placeholder="展示名称" /><Input aria-label="上游模型名" value={row.upstreamModel} onChange={(event) => setProviderModelRows((rows) => rows.map((item, itemIndex) => itemIndex === index ? { ...item, upstreamModel: event.target.value } : item))} placeholder="上游模型名" /><div className="provider-model-picker"><button type="button" className="provider-model-picker-trigger" aria-label="从已获取模型中选择" disabled={!providerModels.length} aria-haspopup="listbox" aria-expanded={providerModelPickerIndex === index} onClick={(event) => { const opening = providerModelPickerIndex !== index; if (opening) { const rect = event.currentTarget.getBoundingClientRect(); const roomBelow = window.innerHeight - rect.bottom; const roomAbove = rect.top; setProviderModelPickerPlacement(roomBelow < 245 && roomAbove > roomBelow ? "above" : "below"); } setProviderModelPickerIndex(opening ? index : null); setProviderModelSearch(""); }}>{row.upstreamModel || "搜索并选择模型"}<ChevronDown aria-hidden="true" className="provider-model-chevron" /></button>{providerModelPickerIndex === index && <div className={`provider-model-picker-menu ${providerModelPickerPlacement}`}><input type="search" autoFocus value={providerModelSearch} onChange={(event) => setProviderModelSearch(event.target.value)} placeholder="搜索模型 ID" aria-label="搜索模型列表" /><div role="listbox" aria-label="可用模型列表">{providerModels.filter((model) => model.toLowerCase().includes(providerModelSearch.trim().toLowerCase())).map((model) => <button type="button" role="option" aria-selected={row.upstreamModel === model} key={model} onClick={() => { setProviderModelRows((rows) => rows.map((item, itemIndex) => itemIndex === index ? { ...item, upstreamModel: model, displayName: item.displayName || model } : item)); setProviderModelPickerIndex(null); setProviderModelSearch(""); }}>{model}</button>)}{!providerModels.some((model) => model.toLowerCase().includes(providerModelSearch.trim().toLowerCase())) && <small>没有匹配的模型</small>}</div></div>}</div><div className="provider-model-row-actions"><button type="button" aria-label={`在第 ${index + 1} 行后添加模型`} title="添加模型行" onClick={() => setProviderModelRows((rows) => [...rows.slice(0, index + 1), { displayName: "", upstreamModel: "" }, ...rows.slice(index + 1)])}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button><button type="button" aria-label={`删除第 ${index + 1} 行模型`} title="删除模型行" disabled={providerModelRows.length <= 1} onClick={() => setProviderModelRows((rows) => rows.filter((_, itemIndex) => itemIndex !== index))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg></button></div></div>)}{providerModels.length > 0 && <small className="provider-model-count">已获取 {providerModels.length} 个模型，可在对应下拉框中选择。</small>}</section>}
        {modelFeedback && <div className={"model-feedback " + (modelFeedback.includes("成功") ? "success" : "")}>{modelFeedback}</div>}
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-100 bg-zinc-50/60 px-6 py-4">
              <Button type="button" variant="outline" disabled={modelTesting} onClick={() => void testModelConnection()}>{modelTesting ? "测试中…" : "测试连接"}</Button>
              <Button type="submit" disabled={modelSaving}>{modelSaving ? "保存中…" : editingModelId ? "保存并使用" : `保存 ${providerModelRows.filter((row) => row.displayName.trim() && row.upstreamModel.trim()).length} 个模型`}</Button>
            </div>
          </form>
        </section>
      </DialogContent>
    </Dialog>
  </main>;
}

export default function Home() {
  type AuthProvider = { id: string; name: string };
  type AuthUser = { id: number; username: string; local?: boolean; identities: Array<{ provider: string; providerUsername: string }> };
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [providers, setProviders] = useState<AuthProvider[]>([]);
  const [authError, setAuthError] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me").then(async (response) => {
      const data = await response.json() as { user?: AuthUser | null; providers?: AuthProvider[] };
      if (!response.ok) throw new Error("无法连接后端服务。");
      if (!cancelled) setUser(data.user);
      if (!cancelled) setProviders(data.providers || []);
    }).catch((error) => { if (!cancelled) setAuthError(error instanceof Error ? error.message : "读取登录状态失败。"); });
    const query = new URLSearchParams(window.location.search);
    if (query.get("auth") === "provider-unlinked") { setAuthMessage("该第三方账号尚未绑定用户。请先注册或登录，然后在登录后的账号栏绑定第三方账号。"); setAuthMode("register"); setShowAuthModal(true); }
    else if (query.get("auth") === "provider-bound") setAuthMessage("第三方账号绑定成功。");
    else if (query.get("auth") === "cancelled") setAuthMessage("第三方登录已取消。");
    else if (query.get("auth") === "bind-failed") setAuthMessage(query.get("message") || "第三方账号绑定失败。");
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onOAuthPopupMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !event.data || typeof event.data !== "object" || event.data.type !== "little-sunshine-oauth") return;
      const result = event.data as { auth?: string; message?: string; provider?: string };
      if (result.auth === "provider-unlinked") {
        setUser(null);
        const providerName = providers.find((provider) => provider.id === result.provider)?.name || result.provider || "第三方平台";
        setAuthMessage(`该 ${providerName} 账号尚未绑定用户。请先注册或登录，然后在登录后的账户菜单中绑定第三方账号。`);
        setAuthMode("register");
        setShowAuthModal(true);
      } else if (result.auth === "cancelled" || result.auth === "bind-failed") {
        setAuthMessage(result.message || (result.auth === "cancelled" ? "第三方授权已取消。" : "第三方账号绑定失败。"));
        setShowAuthModal(true);
      } else if (result.auth === "success" || result.auth === "provider-bound") {
        void fetch("/api/auth/me").then(async (response) => {
          const data = await response.json() as { user?: AuthUser | null; providers?: AuthProvider[] };
          if (!response.ok) throw new Error("无法读取授权后的登录状态。");
          setUser(data.user ?? null);
          setProviders(data.providers || []);
          setShowAuthModal(false);
          setAuthError("");
        }).catch((error) => setAuthError(error instanceof Error ? error.message : "读取登录状态失败。"));
      }
    };
    window.addEventListener("message", onOAuthPopupMessage);
    return () => window.removeEventListener("message", onOAuthPopupMessage);
  }, []);

  const openAuth = (mode: "login" | "register") => { setAuthMode(mode); setAuthError(""); setShowAuthModal(true); };
  const defaultOAuthProviders: AuthProvider[] = [
    { id: "github", name: "GitHub" },
    { id: "gitee", name: "Gitee" },
    { id: "google", name: "Google" },
  ];
  const oauthButtons = [
    ...defaultOAuthProviders.map((provider) => providers.find((configured) => configured.id === provider.id) || provider),
    ...providers.filter((provider) => !defaultOAuthProviders.some((builtIn) => builtIn.id === provider.id)),
  ];
  const openOAuthPopup = (provider: AuthProvider) => {
    setAuthError("");
    if (!providers.some((configured) => configured.id === provider.id)) {
      setAuthError(`后端尚未配置 ${provider.name} 登录，请在 auth.json 中填写对应平台的 clientId 和 clientSecret。`);
      return;
    }
    const width = 600;
    const height = 720;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
    const popup = window.open(`/api/auth/oauth/${encodeURIComponent(provider.id)}?popup=1`, "little-sunshine-oauth", `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
    if (!popup) setAuthError("浏览器拦截了授权弹窗，请允许此网站打开弹出窗口后重试。");
  };
  return <>
    {!user && <div className="guest-auth-bar"><button type="button" className="primary" onClick={() => openAuth("login")}>登录/注册</button></div>}
    <ChatApp authenticated={Boolean(user)} userId={user?.id} username={user?.username} unboundProviders={user ? providers.filter((provider) => !user.identities.some((identity) => identity.provider === provider.id)) : []} onRequireLogin={() => openAuth("login")} onLogout={async () => { await fetch("/api/auth/me", { method: "DELETE" }); window.location.reload(); }} />
    {showAuthModal && !user && <div className="auth-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowAuthModal(false); }}><section className="auth-card auth-modal-card" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title"><button type="button" className="auth-modal-close" aria-label="关闭" onClick={() => setShowAuthModal(false)}>×</button><div className="auth-sun">☀</div><h1 id="auth-modal-title">Little Sunshine</h1><p>{authMode === "login" ? "登录你的 Little Sunshine 账号" : "创建 Little Sunshine 账号"}</p>
    {authMessage && <div className="auth-message">{authMessage}</div>}{authError && user === undefined && <button type="button" className="auth-secondary-button" onClick={() => window.location.reload()}>重新连接</button>}
      <form className="auth-form" onSubmit={async (event) => {
        event.preventDefault(); setAuthError(""); setAuthLoading(true);
        try {
          const response = await fetch(`/api/auth/${authMode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
          const data = await response.json() as { error?: string };
          if (!response.ok) throw new Error(data.error || (authMode === "register" ? "注册失败。" : "登录失败。"));
          window.location.reload();
        } catch (error) { setAuthError(error instanceof Error ? error.message : "请求失败，请稍后重试。"); }
        finally { setAuthLoading(false); }
      }}>
        <Input required autoComplete="username" minLength={3} maxLength={32} value={username} onChange={(event) => setUsername(event.target.value)} placeholder="用户名" />
        <Input required type="password" autoComplete={authMode === "register" ? "new-password" : "current-password"} minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码（至少 8 位）" />
        {authError && <div className="auth-error" role="alert">{authError}</div>}
        <button type="submit" className="github-login-button" disabled={authLoading}>{authLoading ? "处理中…" : authMode === "register" ? "注册并登录" : "登录"}</button>
      </form>
      <div className="auth-providers"><div className="auth-provider-divider"><span>或使用第三方账号</span></div><div className="auth-provider-icons">{oauthButtons.map((provider) => <button key={provider.id} type="button" className="auth-provider-icon-button" aria-label={`使用 ${provider.name} 授权`} onClick={() => openOAuthPopup(provider)}><span className="auth-provider-tooltip" aria-hidden="true">{provider.name}</span>{provider.id === "github" ? <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .9a11.1 11.1 0 0 0-3.51 21.63c.55.1.76-.24.76-.54v-2.08c-3.1.68-3.75-1.32-3.75-1.32-.5-1.3-1.23-1.65-1.23-1.65-1.01-.69.08-.68.08-.68 1.12.08 1.7 1.15 1.7 1.15.99 1.69 2.6 1.2 3.23.92.1-.72.39-1.2.7-1.48-2.48-.28-5.09-1.24-5.09-5.51 0-1.22.44-2.21 1.15-2.99-.12-.28-.5-1.42.11-2.95 0 0 .94-.3 3.05 1.14a10.6 10.6 0 0 1 5.55 0c2.11-1.44 3.04-1.14 3.04-1.14.61 1.53.23 2.67.12 2.95.71.78 1.14 1.77 1.14 2.99 0 4.28-2.61 5.22-5.1 5.5.4.34.75 1.02.75 2.06v3.09c0 .3.2.65.76.54A11.1 11.1 0 0 0 12 .9Z" /></svg> : provider.id === "gitee" ? <span className="gitee-provider-mark">G</span> : provider.id === "google" ? <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.7c3.9-3.6 6-8.8 6-15Z"/><path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.8l-6.7-5.1c-1.8 1.2-4 1.9-6.8 1.9-5.2 0-9.6-3.5-11.2-8.2H5.9v5.2C9.3 39.6 16.1 44 24 44Z"/><path fill="#FBBC05" d="M12.8 27.8a12 12 0 0 1 0-7.6V15H5.9a20 20 0 0 0 0 18l6.9-5.2Z"/><path fill="#EA4335" d="M24 12.1c3 0 5.7 1 7.8 3.1l5.9-5.9C34.1 6 29.5 4 24 4 16.1 4 9.3 8.4 5.9 15l6.9 5.2c1.6-4.7 6-8.1 11.2-8.1Z"/></svg> : <span>{provider.name.slice(0, 1).toUpperCase()}</span>}</button>)}</div><small>第三方账号仅用于绑定已有用户</small></div>
      <button type="button" className="auth-mode-button" onClick={() => { setAuthMode((mode) => mode === "login" ? "register" : "login"); setAuthError(""); }}>{authMode === "login" ? "没有账号？注册" : "已有账号？登录"}</button>
  </section></div>}
  </>;
}

function ChatResultList({ records }: { records: UsageRecord[] }) {
  return <section className="chat-result-list" aria-label="查询记录列表">
    <div className="chat-result-heading"><strong>查询明细</strong><span>本次返回 {records.length} 条 · 可滚动查看</span></div>
    {records.length ? <div className="chat-result-scroll"><table><thead><tr><th>模型 / 时间</th><th>Token</th><th>费用</th><th>状态</th></tr></thead><tbody>
      {records.map((record) => <tr key={record.request_id}>
        <td><strong>{record.model_name}</strong><small>{record.request_id.slice(0, 12)} · {timeLabel(record.request_received_at)}</small></td>
        <td>{formatNumber(record.total_tokens > 0 ? record.total_tokens : record.prompt_tokens + record.completion_tokens + record.cache_hit_tokens)}</td>
        <td>{displayCost(Number(record.total_cost) !== 0 ? record.total_cost : record.estimated_cost)}</td>
        <td><span className={"chat-record-status " + (record.status.toLowerCase() === "success" ? "ok" : "failed")}>{record.status}</span></td>
      </tr>)}
    </tbody></table></div> : <div className="chat-result-empty">没有匹配的记录</div>}
  </section>;
}

