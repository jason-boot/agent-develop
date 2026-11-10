import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [appAddress, pairingCode] = process.argv.slice(2);
if (!appAddress || !pairingCode) {
  console.error('Usage: npm run local -- <app-url> <pairing-code>');
  process.exit(1);
}
const app = new URL(appAddress);
if (!['http:', 'https:'].includes(app.protocol)) throw new Error('App URL must use HTTP or HTTPS');
const endpoint = new URL('/api/mcp/browser-bridge', app);
const installDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(installDirectory, 'plugins');
const pluginManifestName = '.browserbridge-mcp.json';
const bridgeVersion = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).version;
const dataDirectory = path.join(homedir(), '.little-sunshine', 'data');
const legacyConfigPath = path.join(homedir(), '.little-sunshine', 'local-mcp-servers.json');
let configDirectory = '';
let configPath = '';
const configs = new Map();
const servers = new Map();
const serverErrors = new Map();

function validateServerId(value) {
  const id = String(value || '');
  const npmPackageName = parseNpmPackageSpec(id)?.packageName === id;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) && !npmPackageName) throw new Error('本地 MCP 编号无效。');
  return id;
}

function stablePluginServerId(packageName) {
  const parsed = parseNpmPackageSpec(packageName);
  if (!parsed) throw new Error('npm 包名无效，无法生成本地 MCP 编号。');
  return parsed.packageName;
}

function parseNpmPackageSpec(value) {
  if (typeof value !== 'string') return null;
  const scoped = value.startsWith('@');
  const versionSeparator = scoped ? value.indexOf('@', value.indexOf('/') + 1) : value.indexOf('@');
  const packageName = versionSeparator < 0 ? value : value.slice(0, versionSeparator);
  const version = versionSeparator < 0 ? '' : value.slice(versionSeparator + 1);
  const validName = /^(@[a-zA-Z0-9._~-]+\/[a-zA-Z0-9._~-]+|[a-zA-Z0-9._~-]+)$/.test(packageName);
  if (!validName || (version && !/^[a-zA-Z0-9._~+^-]+$/.test(version))) return null;
  return { packageName, packageSpec: version ? value : `${packageName}@latest` };
}

function normalizeConfig(value, previous) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本地 MCP 配置无效。');
  const command = String(value.command || '').trim();
  const args = value.args;
  const inputEnv = value.env;
  const cwd = String(value.cwd || '').trim();
  if (!command || command.length > 2048 || command.includes('\0')) throw new Error('请填写有效的本地 MCP 启动命令。');
  if (!Array.isArray(args) || args.length > 64 || args.some((item) => typeof item !== 'string' || item.length > 4096 || item.includes('\0'))) throw new Error('本地 MCP 参数必须是最多 64 项的字符串数组。');
  if (!inputEnv || typeof inputEnv !== 'object' || Array.isArray(inputEnv)) throw new Error('环境变量必须是 JSON 对象。');
  if (cwd.length > 4096 || cwd.includes('\0')) throw new Error('工作目录格式不正确。');
  const env = {};
  for (const [key, item] of Object.entries(inputEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== 'string' || item.length > 8192 || item.includes('\0')) throw new Error('本地 MCP 环境变量格式不正确。');
    // Empty values preserve existing local secrets when editing a configuration.
    if (item !== '') env[key] = item;
    else if (previous?.env?.[key] !== undefined) env[key] = previous.env[key];
  }
  const packageName = typeof value.packageName === 'string' && parseNpmPackageSpec(value.packageName) ? value.packageName : previous?.packageName;
  const installDirectory = typeof value.installDirectory === 'string' ? value.installDirectory : previous?.installDirectory;
  const installSource = typeof value.installSource === 'string' ? value.installSource : previous?.installSource;
  const installedVersion = typeof value.installedVersion === 'string' ? value.installedVersion : previous?.installedVersion;
  return { command, args, env, cwd, ...(packageName ? { packageName } : {}), ...(installDirectory ? { installDirectory } : {}), ...(installSource ? { installSource } : {}), ...(installedVersion ? { installedVersion } : {}) };
}

async function loadConfigs(configScope) {
  if (!/^\d+$/.test(configScope)) throw new Error('配对响应中的本地配置账号编号无效。');
  configDirectory = path.join(dataDirectory, 'accounts', configScope);
  configPath = path.join(configDirectory, 'local-mcp-servers.json');
  await mkdir(configDirectory, { recursive: true });
  try {
    await readFile(configPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try { await rename(legacyConfigPath, configPath); }
    catch (migrationError) { if (migrationError?.code !== 'ENOENT') throw migrationError; }
  }
  try {
    const contents = JSON.parse(await readFile(configPath, 'utf8'));
    if (!contents || typeof contents !== 'object' || Array.isArray(contents)) throw new Error('配置根节点无效。');
    let migrated = false;
    const legacyDirectories = [];
    for (const [rawId, rawConfig] of Object.entries(contents)) {
      const id = validateServerId(rawId);
      let config = normalizeConfig(rawConfig);
      const installation = config.installDirectory ? managedPluginInfo(config.installDirectory) : null;
      const packageName = config.packageName || installation?.packageName;
      const isPreset = id === 'mysql' || id === 'playwright';
      const canonicalId = packageName && !isPreset ? stablePluginServerId(packageName) : id;
      if (packageName && !config.packageName) config = { ...config, packageName };
      if (packageName && !isPreset && config.installDirectory) {
        const canonicalDirectory = pluginDirectoryForPackage(packageName);
        const oldDirectory = path.resolve(config.installDirectory);
        if (oldDirectory.startsWith(`${path.resolve(pluginRoot)}${path.sep}`) && oldDirectory !== path.resolve(canonicalDirectory)) {
          try {
            await readFile(path.join(canonicalDirectory, 'node_modules', ...packageName.split('/'), 'package.json'), 'utf8');
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            await mkdir(path.dirname(canonicalDirectory), { recursive: true });
            await cp(config.installDirectory, canonicalDirectory, { recursive: true, errorOnExist: true, force: false });
          }
          config = { ...config, installDirectory: canonicalDirectory };
          legacyDirectories.push(config.installDirectory === canonicalDirectory ? oldDirectory : '');
        }
      }
      if (packageName) {
        const shownConfig = displayConfig(config);
        if (shownConfig.command !== config.command || JSON.stringify(shownConfig.args) !== JSON.stringify(config.args) || shownConfig.cwd !== config.cwd) migrated = true;
        config = shownConfig;
      }
      configs.set(canonicalId, config);
      if (canonicalId !== id || canonicalId !== rawId || packageName && !rawConfig?.packageName || legacyDirectories.length) migrated = true;
    }
    if (migrated) {
      await saveConfigs();
      for (const directory of legacyDirectories) {
        if (directory && !otherAccountReferencesPluginDirectory(directory)) {
          try { await rm(directory, { recursive: true, force: true }); }
          catch (error) { console.error(`[BrowserBridge] Could not remove legacy plugin directory ${directory}: ${error instanceof Error ? error.message : error}`); }
        }
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`本机 MCP 配置读取失败：${error instanceof Error ? error.message : error}`);
  }
}

async function saveConfigs() {
  await mkdir(configDirectory, { recursive: true });
  const contents = Object.fromEntries(configs.entries());
  await writeFile(configPath, JSON.stringify(contents, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function redact(message, env = {}) {
  let result = String(message || '未知错误');
  for (const value of Object.values(env)) if (value && value.length >= 4) result = result.split(value).join('[已隐藏]');
  return result.slice(0, 1200);
}

function toolList(serverId, tools) {
  return tools.map((tool) => ({
    serverId,
    name: tool.name,
    title: typeof tool.title === 'string' ? tool.title : undefined,
    description: typeof tool.description === 'string' ? tool.description : undefined,
    inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
    annotations: {
      readOnlyHint: tool.annotations?.readOnlyHint === true,
      destructiveHint: tool.annotations?.destructiveHint === true,
    },
  }));
}

function allTools() {
  return [...servers.entries()].flatMap(([id, entry]) => toolList(id, entry.tools));
}

function mcpStatuses() {
  const ids = new Set(['mysql', 'playwright', ...installedPluginIds(), ...configs.keys(), ...servers.keys(), ...serverErrors.keys()]);
  return [...ids].map((id) => {
    const installSource = npxInstallSource(id, configs.get(id));
    const config = configs.get(id);
    const installation = id === 'mysql' ? detectMysqlInstallation(config) : id === 'playwright' ? detectPlaywrightInstallation(config) : detectManagedNpmInstallation(id, config);
    const effectiveInstallSource = installSource || config?.installSource || (id === 'mysql' && installation?.installed ? '@futuretea/mysql-mcp-server' : id === 'playwright' && installation?.installed ? '@playwright/mcp' : '');
    return {
      id,
      configured: configs.has(id),
      connected: servers.has(id),
      toolCount: servers.get(id)?.tools.length || 0,
      ...(effectiveInstallSource ? { installSource: effectiveInstallSource } : {}),
      ...(installation || {}),
      ...(installation?.packageName ? { packageName: installation.packageName } : {}),
      ...(serverErrors.has(id) ? { error: serverErrors.get(id) } : {}),
    };
  });
}

function installedPluginIds() {
  return [...new Set(managedPluginDirectories().map(({ info }) => stablePluginServerId(info.packageName)))];
}

function managedPluginDirectories() {
  const result = [];
  try {
    for (const entry of readdirSync(pluginRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      const firstLevel = path.join(pluginRoot, entry.name);
      if (entry.name.startsWith('@')) {
        try {
          for (const scopedPackage of readdirSync(firstLevel, { withFileTypes: true })) {
            if (!scopedPackage.isDirectory()) continue;
            const directory = path.join(firstLevel, scopedPackage.name);
            const info = managedPluginInfo(directory);
            if (info) result.push({ directory, info });
          }
        } catch { /* The scope directory may not contain installed packages. */ }
        continue;
      }
      const info = managedPluginInfo(firstLevel);
      if (info) result.push({ directory: firstLevel, info });
    }
  } catch { /* The plugins directory is created on first install. */ }
  return result;
}

function managedPluginInfo(directory) {
  try {
    const rootMetadata = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    let manifest = {};
    try { manifest = JSON.parse(readFileSync(path.join(directory, pluginManifestName), 'utf8')); }
    catch { /* Older plugin directories do not have a BrowserBridge manifest. */ }
    const packageName = manifest.packageName || Object.keys(rootMetadata.dependencies || {})[0];
    if (typeof packageName !== 'string' || !parseNpmPackageSpec(packageName)) return null;
    const packageMetadata = JSON.parse(readFileSync(path.join(directory, 'node_modules', ...packageName.split('/'), 'package.json'), 'utf8'));
    return { packageName, manifest, installedVersion: typeof packageMetadata.version === 'string' ? packageMetadata.version : undefined };
  } catch { return null; }
}

function pluginDirectoryForPackage(packageName) {
  const parsed = parseNpmPackageSpec(packageName);
  if (!parsed) throw new Error('npm 包名无效，无法确定本地安装目录。');
  return path.join(pluginRoot, ...parsed.packageName.split('/'));
}

function findManagedPluginDirectory(packageName) {
  return managedPluginDirectories().find(({ info }) => info.packageName === packageName)?.directory || '';
}

async function recordPluginPackage(directory, packageName) {
  const manifestPath = path.join(directory, pluginManifestName);
  await writeFile(manifestPath, JSON.stringify({ packageName }, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function otherAccountReferencesPluginDirectory(directory) {
  const target = path.resolve(directory);
  try {
    for (const entry of readdirSync(path.join(dataDirectory, 'accounts'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const accountDirectory = path.join(dataDirectory, 'accounts', entry.name);
      if (path.resolve(accountDirectory) === path.resolve(configDirectory)) continue;
      try {
        const contents = JSON.parse(readFileSync(path.join(accountDirectory, 'local-mcp-servers.json'), 'utf8'));
        if (Object.values(contents).some((config) => config?.installDirectory && path.resolve(config.installDirectory) === target)) return true;
      } catch { /* Missing or malformed account configs do not reference this package directory. */ }
    }
  } catch { /* Account config storage may not exist yet. */ }
  return false;
}

function detectMysqlInstallation(config) {
  const candidates = new Set([
    pluginDirectoryForPackage('@futuretea/mysql-mcp-server'),
    path.join(installDirectory, 'plugins', 'mysql'),
    path.join(installDirectory, 'plugins'),
    path.resolve(config?.installDirectory || config?.cwd || installDirectory),
    installDirectory,
  ]);
  for (const directory of candidates) {
    try {
      const metadata = JSON.parse(readFileSync(path.join(directory, 'node_modules', '@futuretea', 'mysql-mcp-server', 'package.json'), 'utf8'));
      return { installed: true, packageName: '@futuretea/mysql-mcp-server', installDirectory: directory, ...(typeof metadata.version === 'string' ? { installedVersion: metadata.version } : {}) };
    } catch { /* Check the next known installation location. */ }
  }
  return { installed: false };
}

function detectPlaywrightInstallation(config) {
  const candidates = new Set([
    pluginDirectoryForPackage('@playwright/mcp'),
    path.join(installDirectory, 'plugins', 'playwright'),
    path.join(installDirectory, 'plugins'),
    path.resolve(config?.installDirectory || config?.cwd || installDirectory),
    installDirectory,
  ]);
  for (const directory of candidates) {
    try {
      const metadata = JSON.parse(readFileSync(path.join(directory, 'node_modules', '@playwright', 'mcp', 'package.json'), 'utf8'));
      return { installed: true, packageName: '@playwright/mcp', installDirectory: directory, ...(typeof metadata.version === 'string' ? { installedVersion: metadata.version } : {}) };
    } catch { /* Check the next known installation location. */ }
  }
  return { installed: false };
}

function detectManagedNpmInstallation(serverId, config) {
  const entries = managedPluginDirectories();
  const configDirectory = config?.installDirectory ? path.resolve(config.installDirectory) : '';
  const match = entries.find(({ directory, info }) => {
    if (configDirectory) return path.resolve(directory) === configDirectory && (!config.packageName || info.packageName === config.packageName);
    return stablePluginServerId(info.packageName) === serverId || path.basename(directory) === serverId;
  });
  if (!match) return { installed: false };
  return { installed: true, installDirectory: match.directory, packageName: match.info.packageName, ...(match.info.installedVersion ? { installedVersion: match.info.installedVersion } : {}) };
}

function splitShellArguments(value) {
  return [...value.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map((match) => match[1] ?? match[2] ?? match[3]).filter((argument) => argument !== '&' && argument !== '&&');
}

function npxMcpInvocation(config) {
  const commandName = path.basename(config.command).toLowerCase();
  if (['npx', 'npx.cmd', 'npx.exe'].includes(commandName)) {
    const args = config.args;
    const yesIndex = args.findIndex((argument) => argument === '-y' || argument === '--yes');
    const packageIndex = yesIndex >= 0 ? yesIndex + 1 : args.findIndex((argument) => Boolean(parseNpmPackageSpec(argument)));
    const parsed = parseNpmPackageSpec(args[packageIndex]);
    if (!parsed) return null;
    return { ...parsed, source: args[packageIndex], commandArgs: args.slice(packageIndex + 1) };
  }
  const shellCommand = [config.command, ...config.args].join(' ');
  const match = /(?:^|\s)npx(?:\.cmd)?\s+(?:-y|--yes)\s+(?:"([^"]+)"|'([^']+)'|([^\s"'&|]+))(?:\s+(.+?))?\s*$/i.exec(shellCommand);
  if (!match) return null;
  const source = match[1] ?? match[2] ?? match[3];
  const parsed = parseNpmPackageSpec(source);
  if (!parsed) return null;
  return { ...parsed, source, commandArgs: match[4] ? splitShellArguments(match[4]) : [] };
}

function executableFromPackage(metadata, packageDirectory) {
  const bins = typeof metadata.bin === 'string' ? [[metadata.name?.split('/').pop() || '', metadata.bin]] : Object.entries(metadata.bin || {});
  if (!bins.length) throw new Error('这个 npm 包没有可执行入口，无法作为本地 MCP 启动。');
  const defaultName = metadata.name?.split('/').pop() || '';
  const selected = bins.find(([name]) => name === defaultName) || (bins.length === 1 ? bins[0] : null);
  if (!selected) throw new Error(`这个 npm 包包含多个命令入口（${bins.map(([name]) => name).join('、')}），请填写一个明确的启动命令。`);
  const executable = path.resolve(packageDirectory, selected[1]);
  if (executable !== packageDirectory && !executable.startsWith(`${packageDirectory}${path.sep}`)) throw new Error('npm 包启动文件路径无效。');
  return executable;
}

async function installNpxMcpToPlugins(serverId, config) {
  const invocation = npxMcpInvocation(config);
  if (!invocation) return config;
  const pluginDirectory = pluginDirectoryForPackage(invocation.packageName);
  const packageDirectory = path.join(pluginDirectory, 'node_modules', ...invocation.packageName.split('/'));
  const packageMetadataPath = path.join(packageDirectory, 'package.json');
  let metadata;
  try { metadata = JSON.parse(await readFile(packageMetadataPath, 'utf8')); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`读取已安装 MCP 包失败：${error instanceof Error ? error.message : error}`);
    const reusableDirectory = findManagedPluginDirectory(invocation.packageName);
    if (reusableDirectory && path.resolve(reusableDirectory) !== path.resolve(pluginDirectory)) {
      await mkdir(path.dirname(pluginDirectory), { recursive: true });
      await cp(reusableDirectory, pluginDirectory, { recursive: true, errorOnExist: true, force: false });
    } else {
      await runNpmInstall(pluginDirectory, invocation.packageSpec);
    }
    metadata = JSON.parse(await readFile(packageMetadataPath, 'utf8'));
  }
  await recordPluginPackage(pluginDirectory, invocation.packageName);
  console.log(`[BrowserBridge] ${serverId} MCP 使用本地安装包 ${invocation.packageName}@${metadata.version || 'unknown'} (${pluginDirectory})`);
  return {
    ...config,
    packageName: invocation.packageName,
    installDirectory: pluginDirectory,
    installSource: invocation.source,
    ...(typeof metadata.version === 'string' ? { installedVersion: metadata.version } : {}),
  };
}

async function runNpmInstall(pluginDirectory, packageSpec) {
  const npmCliPath = process.env.npm_execpath;
  if (!npmCliPath) throw new Error('无法定位 npm。请通过 Start-BrowserBridge 启动桥接工具后重试。');
  await mkdir(pluginDirectory, { recursive: true });
  const npmArgs = ['install', '--prefix', pluginDirectory, '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', packageSpec];
  const quoteCommandArg = (value) => /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
  console.log(`[BrowserBridge] MCP 安装命令: npm ${npmArgs.map(quoteCommandArg).join(' ')}`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCliPath, ...npmArgs], {
      cwd: pluginDirectory,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk) => { output = `${output}${chunk}`.slice(-4000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timeout = setTimeout(() => child.kill(), 240_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`npm 安装失败（退出代码 ${code ?? '未知'}）。${output.trim()}`));
    });
  });
}

async function installMcpPackage(serverId, packageName) {
  const pluginDirectory = pluginDirectoryForPackage(packageName);
  const packagePath = path.join(pluginDirectory, 'node_modules', ...packageName.split('/'), 'package.json');
  let metadata;
  try { metadata = JSON.parse(await readFile(packagePath, 'utf8')); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`读取已安装 MCP 包失败：${error instanceof Error ? error.message : error}`);
    const reusableDirectory = findManagedPluginDirectory(packageName);
    if (reusableDirectory && path.resolve(reusableDirectory) !== path.resolve(pluginDirectory)) {
      await mkdir(path.dirname(pluginDirectory), { recursive: true });
      await cp(reusableDirectory, pluginDirectory, { recursive: true, errorOnExist: true, force: false });
    } else {
      await runNpmInstall(pluginDirectory, `${packageName}@latest`);
    }
    metadata = JSON.parse(await readFile(packagePath, 'utf8'));
  }
  await recordPluginPackage(pluginDirectory, packageName);
  const currentConfigDirectory = configs.get(serverId)?.installDirectory ? path.resolve(configs.get(serverId).installDirectory) : '';
  const reusableDirectory = findManagedPluginDirectory(packageName);
  if (reusableDirectory && path.resolve(reusableDirectory) !== path.resolve(pluginDirectory) && path.resolve(reusableDirectory) !== currentConfigDirectory && !otherAccountReferencesPluginDirectory(reusableDirectory)) {
    try { await rm(reusableDirectory, { recursive: true, force: true }); }
    catch (error) { console.error(`[BrowserBridge] Could not remove legacy plugin directory ${reusableDirectory}: ${error instanceof Error ? error.message : error}`); }
  }
  return { installed: true, installedVersion: metadata.version, installDirectory: pluginDirectory, mcpServers: mcpStatuses() };
}

async function installMysqlMcp() { return installMcpPackage('mysql', '@futuretea/mysql-mcp-server'); }
async function installPlaywrightMcp() { return installMcpPackage('playwright', '@playwright/mcp'); }
async function installBuiltinMcp(serverId) {
  const packages = {
    '@modelcontextprotocol/server-filesystem': '@modelcontextprotocol/server-filesystem',
    '@modelcontextprotocol/server-memory': '@modelcontextprotocol/server-memory',
    '@modelcontextprotocol/server-sequential-thinking': '@modelcontextprotocol/server-sequential-thinking',
    '@modelcontextprotocol/server-everything': '@modelcontextprotocol/server-everything',
  };
  const packageName = packages[serverId];
  if (!packageName) throw new Error('这个内置 MCP 不在允许安装列表中。');
  if (serverId === '@modelcontextprotocol/server-sequential-thinking' && Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('Sequential Thinking 当前版本需要 Node.js 24 或更新版本。请更新本机 Node.js 和 BrowserBridge 后再安装。');
  }
  return installMcpPackage(serverId, packageName);
}

async function uninstallMcpPackage(serverId) {
  const config = configs.get(serverId);
  const presetPackageName = serverId === 'mysql' ? '@futuretea/mysql-mcp-server' : serverId === 'playwright' ? '@playwright/mcp' : '';
  const installation = serverId === 'mysql' ? detectMysqlInstallation(config) : serverId === 'playwright' ? detectPlaywrightInstallation(config) : detectManagedNpmInstallation(serverId, config);
  const packageName = presetPackageName || config?.packageName || installation?.packageName || '';
  if (!packageName) throw new Error('没有检测到由 BrowserBridge 安装的 npm MCP 包。');
  if (!installation?.installed || !installation.installDirectory) throw new Error('没有检测到该 MCP 的本地安装文件。');
  const detectedDirectory = path.resolve(installation.installDirectory);
  const resolvedPluginRoot = path.resolve(pluginRoot);
  const builtinDirectories = new Set([
    path.resolve(pluginRoot, serverId),
    path.resolve(pluginRoot),
    ...(serverId === 'mysql' ? [path.resolve(pluginDirectoryForPackage('@futuretea/mysql-mcp-server'))] : []),
    ...(serverId === 'playwright' ? [path.resolve(pluginDirectoryForPackage('@playwright/mcp'))] : []),
  ]);
  const isManagedDescendant = detectedDirectory.startsWith(`${resolvedPluginRoot}${path.sep}`);
  if (!builtinDirectories.has(detectedDirectory) && !isManagedDescendant) {
    throw new Error('该 MCP 安装在 BrowserBridge/plugins 之外，为避免删除其他文件，未自动卸载。');
  }
  const active = servers.get(serverId);
  if (active) servers.delete(serverId);
  if (active) await Promise.allSettled([active.client.close()]);
  const previousConfig = configs.get(serverId);
  const previousError = serverErrors.get(serverId);
  configs.delete(serverId);
  serverErrors.delete(serverId);
  try { await saveConfigs(); }
  catch (error) {
    if (previousConfig) configs.set(serverId, previousConfig);
    if (previousError) serverErrors.set(serverId, previousError);
    if (active && previousConfig) {
      try { await startMcpServer(serverId, previousConfig); }
      catch (restartError) { serverErrors.set(serverId, redact(restartError instanceof Error ? restartError.message : restartError, previousConfig.env)); }
    }
    throw error;
  }
  if (detectedDirectory === resolvedPluginRoot) {
    await rm(path.join(resolvedPluginRoot, 'node_modules', ...packageName.split('/')), { recursive: true, force: true });
  } else await rm(detectedDirectory, { recursive: true, force: true });
  const duplicateDirectories = new Set([
    path.resolve(pluginDirectoryForPackage(packageName)),
    ...managedPluginDirectories().filter(({ info }) => info.packageName === packageName).map(({ directory }) => path.resolve(directory)),
  ]);
  for (const directory of duplicateDirectories) {
    if (directory === detectedDirectory || directory === resolvedPluginRoot || !directory.startsWith(`${resolvedPluginRoot}${path.sep}`) || otherAccountReferencesPluginDirectory(directory)) continue;
    await rm(directory, { recursive: true, force: true });
  }
  console.log(`[BrowserBridge] Uninstalled local MCP ${serverId} from ${detectedDirectory}`);
  return { uninstalled: true, removedServerId: serverId, tools: allTools(), mcpServers: mcpStatuses() };
}

function npxInstallSource(serverId, config) {
  if (!config) return '';
  const commandName = path.basename(config.command).toLowerCase();
  if (['npx', 'npx.cmd', 'npx.exe'].includes(commandName)) {
    const yesIndex = config.args.findIndex((arg) => arg === '-y' || arg === '--yes');
    return yesIndex >= 0 ? config.args[yesIndex + 1] || '' : '';
  }
  const commandLine = config.args.join(' ');
  const npxSource = commandLine.match(/\bnpx(?:\.cmd)?\s+(?:-y|--yes)\s+["']?([^\s"'&|]+)/i)?.[1];
  if (npxSource) return npxSource;
  if (serverId === 'mysql' && /mysql-mcp-server(?:\.cmd|\.exe)?/i.test(commandLine)) return '@futuretea/mysql-mcp-server';
  return '';
}

function publicConfig(id) {
  const storedConfig = configs.get(id);
  const config = storedConfig ? displayConfig(storedConfig) : null;
  if (!config) return { serverId: id, configured: false, command: '', args: [], env: {}, cwd: '' };
  return {
    serverId: id,
    configured: true,
    command: config.command,
    args: config.args,
    env: config.env,
    envKeys: Object.keys(config.env),
    cwd: config.cwd,
  };
}

function displayConfig(config) {
  if (!config.packageName || !config.installDirectory || path.basename(config.command) !== path.basename(process.execPath) || !config.args.length) return config;
  const packageDirectory = path.resolve(config.installDirectory, 'node_modules', ...config.packageName.split('/'));
  const storedEntry = path.resolve(config.args[0]);
  if (storedEntry !== packageDirectory && !storedEntry.startsWith(`${packageDirectory}${path.sep}`)) return config;
  return {
    ...config,
    command: 'npx',
    args: ['-y', config.installSource || `${config.packageName}@latest`, ...config.args.slice(1)],
    cwd: config.cwd === config.installDirectory ? '' : config.cwd,
  };
}

function runtimeConfig(config) {
  if (!config.packageName || !config.installDirectory) return config;
  const invocation = npxMcpInvocation(config);
  const packageDirectory = path.resolve(config.installDirectory, 'node_modules', ...config.packageName.split('/'));
  const metadata = JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
  const executable = executableFromPackage(metadata, packageDirectory);
  const isPreviouslyRewritten = config.args[0] && path.resolve(config.args[0]) === executable && path.basename(config.command) === path.basename(process.execPath);
  if (!invocation && !isPreviouslyRewritten) return config;
  const commandArgs = invocation?.commandArgs || (isPreviouslyRewritten ? config.args.slice(1) : []);
  return {
    ...config,
    command: process.execPath,
    args: [executable, ...commandArgs],
    cwd: config.cwd || config.installDirectory,
  };
}

async function startMcpServer(serverId, config) {
  const runtime = runtimeConfig(config);
  const client = new Client({ name: `little-sunshine-${serverId}`, version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: runtime.command,
    args: runtime.args,
    env: { ...process.env, ...config.env },
    ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    stderr: 'inherit',
  });
  transport.onerror = (error) => {
    if (servers.get(serverId)?.client !== client) return;
    const message = redact(error instanceof Error ? error.message : error, config.env);
    serverErrors.set(serverId, message);
    console.error(`[BrowserBridge] Local MCP ${serverId} error: ${message}`);
  };
  transport.onclose = () => {
    if (servers.get(serverId)?.client !== client) return;
    servers.delete(serverId);
    const message = '本机 MCP 进程已退出，请重新配置或启动。';
    serverErrors.set(serverId, message);
    console.error(`[BrowserBridge] Local MCP ${serverId} disconnected.`);
  };
  try {
    await client.connect(transport);
    const result = await client.listTools();
    const previous = servers.get(serverId);
    servers.set(serverId, { client, tools: result.tools, config });
    serverErrors.delete(serverId);
    if (previous) await Promise.allSettled([previous.client.close()]);
    return result.tools.length;
  } catch (error) {
    await Promise.allSettled([client.close()]);
    throw new Error(redact(error instanceof Error ? error.message : error, config.env));
  }
}

async function configureMcp(serverIdValue, configValue, previousServerIdValue) {
  const serverId = validateServerId(serverIdValue);
  const previousServerId = previousServerIdValue ? validateServerId(previousServerIdValue) : serverId;
  const previousConfig = configs.get(previousServerId) || configs.get(serverId);
  const previousActive = servers.get(previousServerId);
  const config = await installNpxMcpToPlugins(serverId, normalizeConfig(configValue, previousConfig));
  const toolCount = await startMcpServer(serverId, config);
  configs.set(serverId, config);
  if (previousServerId !== serverId) {
    configs.delete(previousServerId);
    serverErrors.delete(previousServerId);
  }
  try { await saveConfigs(); }
  catch (error) {
    const active = servers.get(serverId);
    if (active) await Promise.allSettled([active.client.close()]);
    servers.delete(serverId);
    configs.delete(serverId);
    if (previousConfig) configs.set(previousServerId, previousConfig);
    if (previousServerId === serverId && previousConfig) {
      try { await startMcpServer(previousServerId, previousConfig); }
      catch (restartError) { serverErrors.set(previousServerId, redact(restartError instanceof Error ? restartError.message : restartError, previousConfig.env)); }
    }
    throw error;
  }
  if (previousServerId !== serverId && previousActive) {
    servers.delete(previousServerId);
    await Promise.allSettled([previousActive.client.close()]);
  }
  const previousInstallDirectory = previousConfig?.installDirectory;
  if (previousInstallDirectory && config.installDirectory && path.resolve(previousInstallDirectory) !== path.resolve(config.installDirectory) && path.resolve(previousInstallDirectory).startsWith(`${path.resolve(pluginRoot)}${path.sep}`) && !otherAccountReferencesPluginDirectory(previousInstallDirectory)) {
    try { await rm(previousInstallDirectory, { recursive: true, force: true }); }
    catch (error) { console.error(`[BrowserBridge] Could not remove legacy plugin directory ${previousInstallDirectory}: ${error instanceof Error ? error.message : error}`); }
  }
  console.log(`[BrowserBridge] Connected local MCP ${serverId} (${toolCount} tools)`);
  return { serverId, tools: allTools(), mcpServers: mcpStatuses() };
}

async function removeMcp(serverIdValue) {
  const serverId = validateServerId(serverIdValue);
  const active = servers.get(serverId);
  if (active) await Promise.allSettled([active.client.close()]);
  servers.delete(serverId);
  configs.delete(serverId);
  serverErrors.delete(serverId);
  await saveConfigs();
  return { tools: allTools(), mcpServers: mcpStatuses(), removedServerId: serverId };
}

async function getMcpConfig(serverIdValue) {
  return publicConfig(validateServerId(serverIdValue));
}

async function request(action, body = {}, token = '') {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Bridge request failed: ${response.status}`);
  return data;
}

const paired = await request('pair', { code: pairingCode, tools: allTools(), mcpServers: mcpStatuses(), installDirectory, bridgeVersion });
const token = paired.token;
if (typeof token !== 'string' || typeof paired.configScope !== 'string') throw new Error('桥接配对响应缺少本地配置账号信息，请更新 BrowserBridge 后重试。');
await loadConfigs(paired.configScope);
for (const [serverId, config] of configs) {
  try { await startMcpServer(serverId, config); }
  catch (error) {
    const message = redact(error instanceof Error ? error.message : error, config.env);
    serverErrors.set(serverId, message);
    console.error(`[BrowserBridge] Local MCP ${serverId} failed to start: ${message}`);
  }
}
console.log('Connected to Little Sunshine BrowserBridge.');
let running = true;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  running = false;
  for (const entry of servers.values()) void entry.client.close();
});
const callQueue = [];
let processingCalls = false;

async function runBridgeCommand(call) {
  if (call.name === 'bridge_configure_mcp') return configureMcp(call.arguments.serverId, call.arguments.config, call.arguments.previousServerId);
  if (call.name === 'bridge_get_mcp_config') return getMcpConfig(call.arguments.serverId);
  if (call.name === 'bridge_remove_mcp') return removeMcp(call.arguments.serverId);
  if (call.name === 'bridge_install_mysql') return installMysqlMcp();
  if (call.name === 'bridge_install_playwright') return installPlaywrightMcp();
  if (call.name === 'bridge_install_builtin_mcp') return installBuiltinMcp(validateServerId(call.arguments.serverId));
  if (call.name === 'bridge_uninstall_mcp') return uninstallMcpPackage(validateServerId(call.arguments.serverId));
  throw new Error('未知的桥接管理操作。');
}

function resultValue(result) {
  if (result.isError) throw new Error(result.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') || 'MCP 工具执行失败。');
  const text = result.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  if (!text) return result.content;
  try { return JSON.parse(text); } catch { return text; }
}

async function processCallQueue() {
  if (processingCalls) return;
  processingCalls = true;
  try {
    while (running && callQueue.length) {
      const call = callQueue.shift();
      const startedAt = Date.now();
      const displayName = call.serverId === '__bridge__' ? call.name : `${call.serverId}.${call.name}`;
      console.log(`[BrowserBridge] Tool call started: ${displayName}`);
      try {
        let value;
        if (call.serverId === '__bridge__') value = await runBridgeCommand(call);
        else {
          const entry = servers.get(call.serverId);
          if (!entry) throw new Error(`本机 MCP“${call.serverId}”未连接。请在桥接工具页面配置并启动该 MCP。`);
          value = resultValue(await entry.client.callTool({ name: call.name, arguments: call.arguments || {} }));
        }
        await request('complete', { id: call.id, result: value }, token);
        console.log(`[BrowserBridge] Tool call completed: ${displayName} (${Date.now() - startedAt} ms)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[BrowserBridge] Tool call failed: ${displayName} (${Date.now() - startedAt} ms): ${message}`);
        try { await request('complete', { id: call.id, error: message }, token); }
        catch (completionError) { console.error(completionError instanceof Error ? completionError.message : completionError); }
      }
    }
  } finally {
    processingCalls = false;
    if (running && callQueue.length) void processCallQueue();
  }
}

while (running) {
  try {
    const { call } = await request('poll', { tools: allTools(), mcpServers: mcpStatuses(), installDirectory, bridgeVersion }, token);
    if (call) { callQueue.push(call); void processCallQueue(); }
    await delay(1000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === '本机浏览器连接无效。') {
      try {
        await request('resume', { tools: allTools(), mcpServers: mcpStatuses(), installDirectory, bridgeVersion }, token);
        console.log('Reconnected to Little Sunshine after the server restarted.');
        continue;
      } catch (resumeError) {
        console.error(resumeError instanceof Error ? resumeError.message : resumeError);
      }
    } else console.error(message);
    await delay(2000);
  }
}
