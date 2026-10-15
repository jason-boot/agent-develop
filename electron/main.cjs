const { app, BrowserWindow, Menu, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

let serverProcess;
let staticServer;
let mainWindow;
let desktopAppUrl;
let pendingAuthProtocol;
let shuttingDown = false;
app.setName("Usage Copilot");
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
if (app.isPackaged) app.setAsDefaultProtocolClient("usagecopilot");
else app.setAsDefaultProtocolClient("usagecopilot", process.execPath, [path.resolve(process.argv[1] || ".")]);

function handleAuthProtocol(target) {
  let authUrl;
  try { authUrl = new URL(target); } catch (_) { return; }
  if (authUrl.protocol !== "usagecopilot:") return;
  if (!desktopAppUrl) { pendingAuthProtocol = target; return; }
  const ticket = authUrl.searchParams.get("ticket");
  if (!ticket) return;
  const destination = new URL(desktopAppUrl);
  destination.searchParams.set("desktop", "1");
  destination.searchParams.set("desktopAuthTicket", ticket);
  if (!mainWindow || mainWindow.isDestroyed()) { pendingAuthProtocol = target; return; }
  mainWindow.show();
  mainWindow.focus();
  void mainWindow.loadURL(destination.toString());
}

app.on("open-url", (event, target) => { event.preventDefault(); handleAuthProtocol(target); });
app.on("second-instance", (_event, commandLine) => {
  const authProtocol = commandLine.find((argument) => argument.startsWith("usagecopilot://"));
  if (authProtocol) handleAuthProtocol(authProtocol);
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

function openConfigFolder() {
  const configDirectory = app.isPackaged ? app.getPath("userData") : path.join(app.getAppPath(), "backend", ".agent-data");
  fs.mkdirSync(configDirectory, { recursive: true });
  const databaseConfig = path.join(configDirectory, "database.json");
  const exampleConfig = path.join(app.getAppPath(), "backend", "database.example.json");
  if (!fs.existsSync(databaseConfig) && fs.existsSync(exampleConfig)) {
    fs.copyFileSync(exampleConfig, databaseConfig, fs.constants.COPYFILE_EXCL);
    try { fs.chmodSync(databaseConfig, 0o600); } catch (_) { /* Keep platform defaults if chmod is unavailable. */ }
  }
  const desktopAuthConfig = path.join(configDirectory, "desktop-auth.json");
  const desktopAuthExample = path.join(__dirname, "desktop-auth.example.json");
  if (!fs.existsSync(desktopAuthConfig) && fs.existsSync(desktopAuthExample)) {
    fs.copyFileSync(desktopAuthExample, desktopAuthConfig, fs.constants.COPYFILE_EXCL);
    try { fs.chmodSync(desktopAuthConfig, 0o600); } catch (_) { /* Keep platform defaults if chmod is unavailable. */ }
  }
  shell.openPath(configDirectory);
}

function choosePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error("本地服务意外退出，请检查应用配置后重新启动。");
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch (_) {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error("本地服务启动超时，请重新启动应用。");
}

function showStartupError(message) {
  const errorWindow = new BrowserWindow({ width: 560, height: 300, resizable: false, title: "Usage Copilot" });
  const safeMessage = String(message).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  errorWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<meta charset="utf-8"><body style="font:15px system-ui;padding:32px;color:#222"><h2>应用启动失败</h2><p>${safeMessage}</p><p>请检查应用配置目录中的数据库、模型与 MCP 配置。</p></body>`)}`);
}

function startStaticProxy(frontendDirectory, backendPort) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/api" || requestUrl.pathname.startsWith("/api/")) {
        const proxy = http.request({
          hostname: "127.0.0.1",
          port: backendPort,
          method: request.method,
          path: request.url,
          headers: { ...request.headers, host: `127.0.0.1:${backendPort}` },
        }, (upstream) => {
          response.writeHead(upstream.statusCode || 502, upstream.headers);
          upstream.pipe(response);
        });
        proxy.on("error", () => {
          if (!response.headersSent) response.writeHead(502);
          response.end("Backend unavailable");
        });
        request.pipe(proxy);
        return;
      }

      let pathname;
      try {
        pathname = decodeURIComponent(requestUrl.pathname);
      } catch (_) {
        response.writeHead(400).end("Bad request");
        return;
      }
      const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const requestedPath = path.resolve(frontendDirectory, relativePath);
      const filePath = pathname !== "/" && pathname.endsWith("/")
        ? path.join(requestedPath, "index.html")
        : path.extname(requestedPath) ? requestedPath : `${requestedPath}.html`;
      if (filePath !== frontendDirectory && !filePath.startsWith(`${frontendDirectory}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      fs.readFile(filePath, (error, content) => {
        if (error) {
          response.writeHead(404).end("Not found");
          return;
        }
        const extension = path.extname(filePath).toLowerCase();
        const contentTypes = {
          ".css": "text/css; charset=utf-8",
          ".html": "text/html; charset=utf-8",
          ".ico": "image/x-icon",
          ".jpeg": "image/jpeg",
          ".jpg": "image/jpeg",
          ".js": "text/javascript; charset=utf-8",
          ".json": "application/json; charset=utf-8",
          ".png": "image/png",
          ".svg": "image/svg+xml",
          ".txt": "text/plain; charset=utf-8",
          ".webp": "image/webp",
          ".woff": "font/woff",
          ".woff2": "font/woff2",
        };
        response.writeHead(200, { "Content-Type": contentTypes[extension] || "application/octet-stream" });
        if (request.method === "HEAD") response.end();
        else response.end(content);
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法启动本地前端服务。"));
        return;
      }
      staticServer = server;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function createWindow() {
  let url;
  if (!app.isPackaged) {
    const desktopDevUrl = new URL(process.env.DESKTOP_DEV_URL || "http://127.0.0.1:3000");
    desktopDevUrl.searchParams.set("desktop", "1");
    url = desktopDevUrl.toString();
  } else {
    const port = await choosePort();
    const resourceRoot = process.resourcesPath;
    const desktopUrl = new URL(await startStaticProxy(path.join(resourceRoot, "frontend"), port));
    const backendRoot = path.join(resourceRoot, "backend-standalone", "backend");
    const serverPath = path.join(backendRoot, "server.js");
    const environment = {
      ...process.env,
      USAGE_AGENT_CONFIG_DIR: app.getPath("userData"),
      LITTLE_SUNSHINE_RUNTIME: "desktop",
      ELECTRON_RUN_AS_NODE: "1",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      DESKTOP_APP_URL: desktopUrl.origin,
      NODE_ENV: "production",
    };
    serverProcess = spawn(process.execPath, [serverPath], {
      cwd: backendRoot,
      env: environment,
      stdio: "ignore",
      windowsHide: true,
    });
    serverProcess.on("error", () => {});
    await waitForServer(`http://127.0.0.1:${port}/api/health`);
    desktopUrl.searchParams.set("desktop", "1");
    url = desktopUrl.toString();
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 680,
    title: "Usage Copilot",
    backgroundColor: "#f7f8fa",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    const externalUrl = new URL(target);
    if (externalUrl.protocol === "https:" || (externalUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(externalUrl.hostname))) shell.openExternal(target);
    return { action: "deny" };
  });
  const appOrigin = new URL(url).origin;
  desktopAppUrl = url;
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== appOrigin) event.preventDefault();
  });
  await mainWindow.loadURL(url);
  const initialAuthProtocol = process.argv.find((argument) => argument.startsWith("usagecopilot://"));
  const initialHandoff = pendingAuthProtocol || initialAuthProtocol;
  pendingAuthProtocol = undefined;
  if (initialHandoff) handleAuthProtocol(initialHandoff);
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Usage Copilot", submenu: [{ label: "退出", role: "quit" }] },
    { label: "配置", submenu: [{ label: "打开配置目录", click: openConfigFolder }] },
  ]));
  try {
    await createWindow();
  } catch (error) {
    showStartupError(error.message || "未知错误");
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow().catch((error) => showStartupError(error.message));
  });
});

app.on("before-quit", () => {
  shuttingDown = true;
  if (staticServer) staticServer.close();
  if (serverProcess && serverProcess.exitCode === null) serverProcess.kill();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !shuttingDown) app.quit();
});
