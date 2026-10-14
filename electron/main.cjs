const { app, BrowserWindow, Menu, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

let serverProcess;
let mainWindow;
let shuttingDown = false;
app.setName("Usage Copilot");

function openConfigFolder() {
  const configDirectory = app.getPath("userData");
  fs.mkdirSync(configDirectory, { recursive: true });
  const databaseConfig = path.join(configDirectory, "database.json");
  const exampleConfig = path.join(app.getAppPath(), "database.example.json");
  if (!fs.existsSync(databaseConfig) && fs.existsSync(exampleConfig)) {
    fs.copyFileSync(exampleConfig, databaseConfig, fs.constants.COPYFILE_EXCL);
    try { fs.chmodSync(databaseConfig, 0o600); } catch (_) { /* Keep platform defaults if chmod is unavailable. */ }
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

async function createWindow() {
  let url;
  if (!app.isPackaged) {
    url = process.env.DESKTOP_DEV_URL || "http://127.0.0.1:3000";
  } else {
    const port = await choosePort();
    const resourceRoot = process.resourcesPath;
    const serverPath = path.join(resourceRoot, "standalone", "server.js");
    const environment = {
      ...process.env,
      USAGE_AGENT_CONFIG_DIR: app.getPath("userData"),
      ELECTRON_RUN_AS_NODE: "1",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "production",
    };
    serverProcess = spawn(process.execPath, [serverPath], {
      cwd: path.join(resourceRoot, "standalone"),
      env: environment,
      stdio: "ignore",
      windowsHide: true,
    });
    serverProcess.on("error", () => {});
    url = `http://127.0.0.1:${port}`;
    await waitForServer(url);
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
    if (target.startsWith("https://")) shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) event.preventDefault();
  });
  await mainWindow.loadURL(url);
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
  if (serverProcess && serverProcess.exitCode === null) serverProcess.kill();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !shuttingDown) app.quit();
});
