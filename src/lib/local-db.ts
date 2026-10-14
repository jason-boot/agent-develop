import { DatabaseSync } from "node:sqlite";
import mysql, { type Pool } from "mysql2/promise";
import fs from "node:fs";
import { chmod, readFile, rename } from "node:fs/promises";
import path from "node:path";

export type StoredMessage = { role: "assistant" | "user"; content: string; error?: boolean; result?: unknown };
export type StoredConversation = { id: string; title: string; updatedAt: number; pinned: boolean; projectId?: string; projectName?: string; messages: StoredMessage[] };

// Placeholder until authenticated sessions provide a real user ID.
const CURRENT_USER_ID = 1;

declare global {
  // eslint-disable-next-line no-var
  var dqConversationDb: DatabaseSync | undefined;
  // eslint-disable-next-line no-var
  var dqLegacyConfigMigration: Promise<void> | undefined;
  // eslint-disable-next-line no-var
  var dqMysqlPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var dqMysqlSchemaReady: Promise<void> | undefined;
}

function configDirectory() {
  return process.env.USAGE_AGENT_CONFIG_DIR || path.join(process.cwd(), ".agent-data");
}

type DatabaseConfig = {
  provider?: "sqlite" | "mysql";
  mysql?: { host?: string; port?: number; user?: string; password?: string; database?: string; ssl?: boolean; connectionLimit?: number };
};

async function readDatabaseConfig(): Promise<DatabaseConfig> {
  try {
    const config = JSON.parse(await readFile(path.join(configDirectory(), "database.json"), "utf8")) as DatabaseConfig;
    if (config.provider !== "sqlite" && config.provider !== "mysql") throw new Error("provider 必须是 sqlite 或 mysql");
    if (config.provider === "mysql" && (!config.mysql?.host || !config.mysql.user || !config.mysql.password || !config.mysql.database)) {
      throw new Error("MySQL 配置需要填写 host、user、password 和 database");
    }
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { provider: "sqlite" };
    throw new Error(`数据库配置文件 database.json 无法读取：${error instanceof Error ? error.message : "配置错误"}`);
  }
}

function ensureModelConfigColumns(database: DatabaseSync) {
  const columns = database.prepare("PRAGMA table_info(model_configs)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "vendor")) database.exec("ALTER TABLE model_configs ADD COLUMN vendor TEXT NOT NULL DEFAULT 'custom'");
  if (!columns.some((column) => column.name === "models_url")) database.exec("ALTER TABLE model_configs ADD COLUMN models_url TEXT NOT NULL DEFAULT ''");
}

function ensureUserIdColumn(database: DatabaseSync, table: "conversations" | "model_configs" | "external_mcp_servers") {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "user_id")) database.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
}

function ensureAppSettingsUserKey(database: DatabaseSync) {
  const columns = database.prepare("PRAGMA table_info(app_settings)").all() as Array<{ name: string; pk: number }>;
  if (columns.some((column) => column.name === "user_id" && column.pk > 0) && columns.find((column) => column.name === "setting_key")?.pk > 0) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE app_settings_new (
        user_id INTEGER NOT NULL DEFAULT 1,
        setting_key TEXT NOT NULL,
        setting_value TEXT,
        PRIMARY KEY (user_id, setting_key)
      );
      INSERT INTO app_settings_new (user_id, setting_key, setting_value)
        SELECT ${columns.some((column) => column.name === "user_id") ? "user_id" : "1"}, setting_key, setting_value FROM app_settings;
      DROP TABLE app_settings;
      ALTER TABLE app_settings_new RENAME TO app_settings;
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function ensureExternalMcpColumns(database: DatabaseSync) {
  const columns = database.prepare("PRAGMA table_info(external_mcp_servers)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "allowed_tools_json")) database.exec("ALTER TABLE external_mcp_servers ADD COLUMN allowed_tools_json TEXT NOT NULL DEFAULT '[]'");
}

function ensureConversationProjectColumns(database: DatabaseSync) {
  const columns = database.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "project_id")) database.exec("ALTER TABLE conversations ADD COLUMN project_id TEXT");
  if (!columns.some((column) => column.name === "project_name")) database.exec("ALTER TABLE conversations ADD COLUMN project_name TEXT");
  if (!columns.some((column) => column.name === "pinned")) database.exec("ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
}

function getDatabase() {
  if (global.dqConversationDb) {
    ensureUserIdColumn(global.dqConversationDb, "conversations");
    ensureUserIdColumn(global.dqConversationDb, "model_configs");
    ensureUserIdColumn(global.dqConversationDb, "external_mcp_servers");
    ensureAppSettingsUserKey(global.dqConversationDb);
    ensureModelConfigColumns(global.dqConversationDb);
    ensureExternalMcpColumns(global.dqConversationDb);
    ensureConversationProjectColumns(global.dqConversationDb);
    return global.dqConversationDb;
  }
  {
    const directory = configDirectory();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(directory, 0o700); } catch { /* Keep platform defaults if chmod is unavailable. */ }
    const database = new DatabaseSync(path.join(directory, "conversations.sqlite"));
    database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    database.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        project_id TEXT,
        project_name TEXT,
        pinned INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_index INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('assistant', 'user')),
        content TEXT NOT NULL,
        is_error INTEGER NOT NULL DEFAULT 0,
        result_json TEXT,
        UNIQUE (conversation_id, message_index)
      );
      CREATE TABLE IF NOT EXISTS model_configs (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL DEFAULT 1,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        base_url TEXT NOT NULL,
        full_address INTEGER NOT NULL,
        model TEXT NOT NULL,
        api_key TEXT NOT NULL,
        vendor TEXT NOT NULL DEFAULT 'custom',
        models_url TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        user_id INTEGER NOT NULL DEFAULT 1,
        setting_key TEXT NOT NULL,
        setting_value TEXT,
        PRIMARY KEY (user_id, setting_key)
      );
      CREATE TABLE IF NOT EXISTS external_mcp_servers (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL DEFAULT 1,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        token TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        disabled_tools_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_metadata (
        metadata_key TEXT PRIMARY KEY,
        metadata_value TEXT NOT NULL
      );
    `);
    ensureUserIdColumn(database, "conversations");
    ensureUserIdColumn(database, "model_configs");
    ensureUserIdColumn(database, "external_mcp_servers");
    ensureAppSettingsUserKey(database);
    ensureModelConfigColumns(database);
    ensureExternalMcpColumns(database);
    ensureConversationProjectColumns(database);
    try { fs.chmodSync(path.join(directory, "conversations.sqlite"), 0o600); } catch { /* Keep platform defaults if chmod is unavailable. */ }
    global.dqConversationDb = database;
  }
  return global.dqConversationDb;
}

async function getMysqlPool() {
  if (global.dqMysqlPool) return global.dqMysqlPool;
  const config = (await readDatabaseConfig()).mysql!;
  const pool = mysql.createPool({
    host: config.host,
    port: Number(config.port || 3306),
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl ? {} : undefined,
    multipleStatements: false,
    waitForConnections: true,
    connectionLimit: Math.min(Math.max(Number(config.connectionLimit || 8), 1), 32),
    queueLimit: 0,
    timezone: "+08:00",
    enableKeepAlive: true,
  });
  global.dqMysqlPool = pool;
  global.dqMysqlSchemaReady ||= (async () => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS conversations (id VARCHAR(128) PRIMARY KEY, user_id BIGINT NOT NULL DEFAULT 1, title TEXT NOT NULL, updated_at BIGINT NOT NULL, project_id VARCHAR(128) NULL, project_name TEXT NULL, pinned TINYINT NOT NULL DEFAULT 0) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS conversation_messages (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, conversation_id VARCHAR(128) NOT NULL, message_index INT NOT NULL, role VARCHAR(32) NOT NULL, content LONGTEXT NOT NULL, is_error TINYINT NOT NULL DEFAULT 0, result_json LONGTEXT NULL, UNIQUE KEY conversation_message_order (conversation_id, message_index), CONSTRAINT conversation_messages_fk FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS model_configs (id VARCHAR(128) PRIMARY KEY, user_id BIGINT NOT NULL DEFAULT 1, name VARCHAR(255) NOT NULL, protocol VARCHAR(32) NOT NULL, base_url TEXT NOT NULL, full_address TINYINT NOT NULL, model TEXT NOT NULL, api_key TEXT NOT NULL, vendor VARCHAR(128) NOT NULL DEFAULT 'custom', models_url TEXT NOT NULL, sort_order INT NOT NULL DEFAULT 0) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS app_settings (user_id BIGINT NOT NULL DEFAULT 1, setting_key VARCHAR(128) NOT NULL, setting_value TEXT NULL, PRIMARY KEY (user_id, setting_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS external_mcp_servers (id VARCHAR(128) PRIMARY KEY, user_id BIGINT NOT NULL DEFAULT 1, name VARCHAR(255) NOT NULL, url TEXT NOT NULL, token TEXT NOT NULL, enabled TINYINT NOT NULL, disabled_tools_json LONGTEXT NOT NULL, allowed_tools_json LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS app_metadata (metadata_key VARCHAR(128) PRIMARY KEY, metadata_value TEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ];
    for (const statement of statements) await pool.query(statement);
  })().catch(async (error: unknown) => {
    global.dqMysqlSchemaReady = undefined;
    global.dqMysqlPool = undefined;
    await pool.end();
    throw error;
  });
  await global.dqMysqlSchemaReady;
  return pool;
}

async function getProvider() {
  return (await readDatabaseConfig()).provider || "sqlite";
}

type LegacyModel = { id: string; name: string; protocol: string; baseUrl: string; fullAddress?: boolean; model: string; apiKey: string };
type LegacyExternalServer = { id: string; name: string; url: string; token?: string; enabled?: boolean; disabledTools?: string[]; allowedTools?: string[] };

async function readLegacyJson<T>(fileName: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path.join(configDirectory(), fileName), "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`旧配置文件 ${fileName} 无法读取，请先备份并检查文件格式。`);
  }
}

export async function migrateLegacyConfigs() {
  if (global.dqLegacyConfigMigration) return global.dqLegacyConfigMigration;
  global.dqLegacyConfigMigration = (async () => {
    const models = await readLegacyJson<{ models?: LegacyModel[]; defaultModelId?: string | null }>("models.json");
    const external = await readLegacyJson<{ servers?: LegacyExternalServer[] }>("external-mcp-servers.json");
    if (await getProvider() === "mysql") {
      const pool = await getMysqlPool();
      const connection = await pool.getConnection();
      let archiveModels = false;
      let archiveExternal = false;
      try {
        await connection.beginTransaction();
        const [metadataRows] = await connection.execute("SELECT metadata_key FROM app_metadata WHERE metadata_key IN ('models_json_v1', 'external_mcp_json_v1')");
        const migrated = new Set((metadataRows as Array<{ metadata_key: string }>).map((row) => row.metadata_key));
        archiveModels = !migrated.has("models_json_v1") && models !== undefined;
        archiveExternal = !migrated.has("external_mcp_json_v1") && external !== undefined;
        if (!migrated.has("models_json_v1")) {
          for (const [index, item] of (Array.isArray(models?.models) ? models.models : []).entries()) {
            if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.baseUrl !== "string" || typeof item.model !== "string") continue;
            const protocol = item.protocol === "messages" || item.protocol === "responses" ? item.protocol : "chat";
            const inferredFullAddress = protocol === "messages" ? /\/messages$/i.test(item.baseUrl) : protocol === "responses" ? /\/responses$/i.test(item.baseUrl) : /\/chat\/completions$/i.test(item.baseUrl);
            await connection.execute("INSERT IGNORE INTO model_configs (id, user_id, name, protocol, base_url, full_address, model, api_key, vendor, models_url, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'custom', '', ?)", [item.id, CURRENT_USER_ID, item.name, protocol, item.baseUrl, item.fullAddress === undefined ? (inferredFullAddress ? 1 : 0) : item.fullAddress ? 1 : 0, item.model, typeof item.apiKey === "string" ? item.apiKey : "", index]);
          }
          const defaultId = typeof models?.defaultModelId === "string" ? models.defaultModelId : null;
          await connection.execute("INSERT INTO app_settings (user_id, setting_key, setting_value) VALUES (?, 'default_model_id', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [CURRENT_USER_ID, defaultId]);
          await connection.execute("INSERT IGNORE INTO app_metadata (metadata_key, metadata_value) VALUES ('models_json_v1', 'done')");
        }
        if (!migrated.has("external_mcp_json_v1")) {
          for (const item of (Array.isArray(external?.servers) ? external.servers : [])) {
            if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.url !== "string") continue;
            await connection.execute("INSERT IGNORE INTO external_mcp_servers (id, user_id, name, url, token, enabled, disabled_tools_json, allowed_tools_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [item.id, CURRENT_USER_ID, item.name, item.url, typeof item.token === "string" ? item.token : "", item.enabled === false ? 0 : 1, JSON.stringify(Array.isArray(item.disabledTools) ? item.disabledTools.filter((name): name is string => typeof name === "string") : []), JSON.stringify(Array.isArray(item.allowedTools) ? item.allowedTools.filter((name): name is string => typeof name === "string") : [])]);
          }
          await connection.execute("INSERT IGNORE INTO app_metadata (metadata_key, metadata_value) VALUES ('external_mcp_json_v1', 'done')");
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        global.dqLegacyConfigMigration = undefined;
        throw error;
      } finally { connection.release(); }
      for (const fileName of [
        ...(archiveModels ? ["models.json"] : []),
        ...(archiveExternal ? ["external-mcp-servers.json"] : []),
      ]) {
        const legacyPath = path.join(configDirectory(), fileName);
        try { await rename(legacyPath, legacyPath + ".migrated.bak"); } catch { /* File may not exist or may already have been moved. */ }
      }
      return;
    }
    const database = getDatabase();
    const archiveModels = !database.prepare("SELECT 1 FROM app_metadata WHERE metadata_key = 'models_json_v1'").get() && models !== undefined;
    const archiveExternal = !database.prepare("SELECT 1 FROM app_metadata WHERE metadata_key = 'external_mcp_json_v1'").get() && external !== undefined;
    database.exec("BEGIN IMMEDIATE");
    try {
      const migrated = database.prepare("SELECT metadata_value FROM app_metadata WHERE metadata_key = ?");
      if (!migrated.get("models_json_v1")) {
        const insertModel = database.prepare("INSERT OR IGNORE INTO model_configs (id, user_id, name, protocol, base_url, full_address, model, api_key, vendor, models_url, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'custom', '', ?)");
        for (const [index, item] of (Array.isArray(models?.models) ? models.models : []).entries()) {
          if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.baseUrl !== "string" || typeof item.model !== "string") continue;
          const protocol = item.protocol === "messages" || item.protocol === "responses" ? item.protocol : "chat";
          const inferredFullAddress = protocol === "messages" ? /\/messages$/i.test(item.baseUrl) : protocol === "responses" ? /\/responses$/i.test(item.baseUrl) : /\/chat\/completions$/i.test(item.baseUrl);
          insertModel.run(item.id, CURRENT_USER_ID, item.name, protocol, item.baseUrl, item.fullAddress === undefined ? (inferredFullAddress ? 1 : 0) : item.fullAddress ? 1 : 0, item.model, typeof item.apiKey === "string" ? item.apiKey : "", index);
        }
        const defaultId = typeof models?.defaultModelId === "string" ? models.defaultModelId : null;
        database.prepare("INSERT INTO app_settings (user_id, setting_key, setting_value) VALUES (?, 'default_model_id', ?) ON CONFLICT(user_id, setting_key) DO UPDATE SET setting_value = excluded.setting_value").run(CURRENT_USER_ID, defaultId);
        database.prepare("INSERT INTO app_metadata (metadata_key, metadata_value) VALUES ('models_json_v1', 'done')").run();
      }
      if (!migrated.get("external_mcp_json_v1")) {
        const insertServer = database.prepare("INSERT OR IGNORE INTO external_mcp_servers (id, user_id, name, url, token, enabled, disabled_tools_json, allowed_tools_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        for (const item of (Array.isArray(external?.servers) ? external.servers : [])) {
          if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.url !== "string") continue;
          insertServer.run(item.id, CURRENT_USER_ID, item.name, item.url, typeof item.token === "string" ? item.token : "", item.enabled === false ? 0 : 1, JSON.stringify(Array.isArray(item.disabledTools) ? item.disabledTools.filter((name): name is string => typeof name === "string") : []), JSON.stringify(Array.isArray(item.allowedTools) ? item.allowedTools.filter((name): name is string => typeof name === "string") : []));
        }
        database.prepare("INSERT INTO app_metadata (metadata_key, metadata_value) VALUES ('external_mcp_json_v1', 'done')").run();
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      global.dqLegacyConfigMigration = undefined;
      throw error;
    }
    for (const fileName of [
      ...(archiveModels ? ["models.json"] : []),
      ...(archiveExternal ? ["external-mcp-servers.json"] : []),
    ]) {
      const legacyPath = path.join(configDirectory(), fileName);
      try { await rename(legacyPath, legacyPath + ".migrated.bak"); } catch { /* File may not exist or may already have been moved. */ }
    }
    try { await chmod(path.join(configDirectory(), "conversations.sqlite"), 0o600); } catch { /* Keep platform defaults if chmod is unavailable. */ }
  })().catch((error: unknown) => {
    global.dqLegacyConfigMigration = undefined;
    throw error;
  });
  return global.dqLegacyConfigMigration;
}

export async function readModelConfigStore() {
  if (await getProvider() === "mysql") {
    const pool = await getMysqlPool();
    const [rows] = await pool.execute("SELECT id, name, protocol, base_url AS baseUrl, full_address AS fullAddress, model, api_key AS apiKey, vendor, models_url AS modelsUrl FROM model_configs WHERE user_id = ? ORDER BY sort_order, id", [CURRENT_USER_ID]);
    const [defaultRows] = await pool.execute("SELECT setting_value FROM app_settings WHERE user_id = ? AND setting_key = 'default_model_id'", [CURRENT_USER_ID]);
    const defaultRow = (defaultRows as Array<{ setting_value: string | null }>)[0];
    return { models: (rows as Array<{ id: string; name: string; protocol: "chat" | "messages" | "responses"; baseUrl: string; fullAddress: number; model: string; apiKey: string; vendor: string; modelsUrl: string }>).map((row) => ({ ...row, fullAddress: Boolean(row.fullAddress) })), defaultModelId: defaultRow?.setting_value || null };
  }
  const database = getDatabase();
  const rows = database.prepare("SELECT id, name, protocol, base_url AS baseUrl, full_address AS fullAddress, model, api_key AS apiKey, vendor, models_url AS modelsUrl FROM model_configs WHERE user_id = ? ORDER BY sort_order, rowid").all(CURRENT_USER_ID) as Array<{ id: string; name: string; protocol: "chat" | "messages" | "responses"; baseUrl: string; fullAddress: number; model: string; apiKey: string; vendor: string; modelsUrl: string }>;
  const defaultRow = database.prepare("SELECT setting_value FROM app_settings WHERE user_id = ? AND setting_key = 'default_model_id'").get(CURRENT_USER_ID) as { setting_value: string | null } | undefined;
  return { models: rows.map((row) => ({ ...row, fullAddress: Boolean(row.fullAddress) })), defaultModelId: defaultRow?.setting_value || null };
}

export async function writeModelConfigStore(store: { models: Array<{ id: string; name: string; protocol: string; baseUrl: string; fullAddress: boolean; model: string; apiKey: string; vendor?: string; modelsUrl?: string }>; defaultModelId: string | null }) {
  if (await getProvider() === "mysql") {
    const pool = await getMysqlPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("DELETE FROM model_configs WHERE user_id = ?", [CURRENT_USER_ID]);
      for (const [index, model] of store.models.entries()) {
        await connection.execute("INSERT INTO model_configs (id, user_id, name, protocol, base_url, full_address, model, api_key, vendor, models_url, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [model.id, CURRENT_USER_ID, model.name, model.protocol, model.baseUrl, model.fullAddress ? 1 : 0, model.model, model.apiKey, model.vendor || "custom", model.modelsUrl || "", index]);
      }
      await connection.execute("INSERT INTO app_settings (user_id, setting_key, setting_value) VALUES (?, 'default_model_id', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [CURRENT_USER_ID, store.defaultModelId]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    return;
  }
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM model_configs WHERE user_id = ?").run(CURRENT_USER_ID);
    const insert = database.prepare("INSERT INTO model_configs (id, user_id, name, protocol, base_url, full_address, model, api_key, vendor, models_url, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    store.models.forEach((model, index) => insert.run(model.id, CURRENT_USER_ID, model.name, model.protocol, model.baseUrl, model.fullAddress ? 1 : 0, model.model, model.apiKey, model.vendor || "custom", model.modelsUrl || "", index));
    database.prepare("INSERT INTO app_settings (user_id, setting_key, setting_value) VALUES (?, 'default_model_id', ?) ON CONFLICT(user_id, setting_key) DO UPDATE SET setting_value = excluded.setting_value").run(CURRENT_USER_ID, store.defaultModelId);
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

export async function readExternalMcpConfig() {
  if (await getProvider() === "mysql") {
    const pool = await getMysqlPool();
    const [rows] = await pool.execute("SELECT id, name, url, token, enabled, disabled_tools_json AS disabledToolsJson, allowed_tools_json AS allowedToolsJson FROM external_mcp_servers WHERE user_id = ? ORDER BY id", [CURRENT_USER_ID]);
    return { servers: (rows as Array<{ id: string; name: string; url: string; token: string; enabled: number; disabledToolsJson: string; allowedToolsJson: string }>).map((row) => ({ id: row.id, name: row.name, url: row.url, token: row.token, enabled: Boolean(row.enabled), disabledTools: JSON.parse(row.disabledToolsJson) as string[], allowedTools: JSON.parse(row.allowedToolsJson) as string[] })) };
  }
  const rows = getDatabase().prepare("SELECT id, name, url, token, enabled, disabled_tools_json AS disabledToolsJson, allowed_tools_json AS allowedToolsJson FROM external_mcp_servers WHERE user_id = ? ORDER BY rowid").all(CURRENT_USER_ID) as Array<{ id: string; name: string; url: string; token: string; enabled: number; disabledToolsJson: string; allowedToolsJson: string }>;
  return { servers: rows.map((row) => ({ id: row.id, name: row.name, url: row.url, token: row.token, enabled: Boolean(row.enabled), disabledTools: JSON.parse(row.disabledToolsJson) as string[], allowedTools: JSON.parse(row.allowedToolsJson) as string[] })) };
}

export async function writeExternalMcpConfig(store: { servers: Array<{ id: string; name: string; url: string; token: string; enabled: boolean; disabledTools: string[]; allowedTools: string[] }> }) {
  if (await getProvider() === "mysql") {
    const pool = await getMysqlPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("DELETE FROM external_mcp_servers WHERE user_id = ?", [CURRENT_USER_ID]);
      for (const server of store.servers) {
        await connection.execute("INSERT INTO external_mcp_servers (id, user_id, name, url, token, enabled, disabled_tools_json, allowed_tools_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [server.id, CURRENT_USER_ID, server.name, server.url, server.token, server.enabled ? 1 : 0, JSON.stringify(server.disabledTools), JSON.stringify(server.allowedTools)]);
      }
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    return;
  }
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM external_mcp_servers WHERE user_id = ?").run(CURRENT_USER_ID);
    const insert = database.prepare("INSERT INTO external_mcp_servers (id, user_id, name, url, token, enabled, disabled_tools_json, allowed_tools_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    store.servers.forEach((server) => insert.run(server.id, CURRENT_USER_ID, server.name, server.url, server.token, server.enabled ? 1 : 0, JSON.stringify(server.disabledTools), JSON.stringify(server.allowedTools)));
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

export async function listConversations() {
  if (await getProvider() === "mysql") {
    const pool = await getMysqlPool();
    const [rows] = await pool.execute("SELECT id, title, updated_at AS updatedAt, pinned, project_id AS projectId, project_name AS projectName FROM conversations WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC", [CURRENT_USER_ID]);
    return (rows as Array<{ id: string; title: string; updatedAt: number; pinned: number; projectId: string | null; projectName: string | null }>).map((row) => ({ ...row, pinned: Boolean(row.pinned) }));
  }
  return (getDatabase().prepare("SELECT id, title, updated_at AS updatedAt, pinned, project_id AS projectId, project_name AS projectName FROM conversations WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC").all(CURRENT_USER_ID) as Array<{ id: string; title: string; updatedAt: number; pinned: number; projectId: string | null; projectName: string | null }>).map((row) => ({ ...row, pinned: Boolean(row.pinned) }));
}

export async function getConversation(id: string): Promise<StoredConversation | null> {
  if (await getProvider() === "mysql") {
    const pool = await getMysqlPool();
    const [conversationRows] = await pool.execute("SELECT id, title, updated_at AS updatedAt, pinned, project_id AS projectId, project_name AS projectName FROM conversations WHERE id = ? AND user_id = ?", [id, CURRENT_USER_ID]);
    const row = (conversationRows as Array<{ id: string; title: string; updatedAt: number; pinned: number; projectId: string | null; projectName: string | null }>)[0];
    if (!row) return null;
    const [messageRows] = await pool.execute("SELECT role, content, is_error AS error, result_json AS resultJson FROM conversation_messages WHERE conversation_id = ? ORDER BY message_index", [id]);
    const { projectId, projectName, pinned, ...conversation } = row;
    return {
      ...conversation,
      pinned: Boolean(pinned),
      ...(projectId ? { projectId } : {}),
      ...(projectName ? { projectName } : {}),
      messages: (messageRows as Array<{ role: StoredMessage["role"]; content: string; error: number; resultJson: string | null }>).map((message) => ({ role: message.role, content: message.content, ...(message.error ? { error: true } : {}), ...(message.resultJson ? { result: JSON.parse(message.resultJson) } : {}) })),
    };
  }
  const database = getDatabase();
  const row = database.prepare("SELECT id, title, updated_at AS updatedAt, pinned, project_id AS projectId, project_name AS projectName FROM conversations WHERE id = ? AND user_id = ?").get(id, CURRENT_USER_ID) as { id: string; title: string; updatedAt: number; pinned: number; projectId: string | null; projectName: string | null } | undefined;
  if (!row) return null;
  const messages = database.prepare("SELECT role, content, is_error AS error, result_json AS resultJson FROM conversation_messages WHERE conversation_id = ? ORDER BY message_index").all(id) as Array<{ role: StoredMessage["role"]; content: string; error: number; resultJson: string | null }>;
  const { projectId, projectName, pinned, ...conversation } = row;
  return {
    ...conversation,
    pinned: Boolean(pinned),
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.error ? { error: true } : {}),
      ...(message.resultJson ? { result: JSON.parse(message.resultJson) } : {}),
    })),
  };
}

export async function saveConversation(id: string, title: string, messages: StoredMessage[], projectId?: string, projectName?: string) {
  if (await getProvider() === "mysql") {
    const pool = await getMysqlPool();
    const connection = await pool.getConnection();
    const updatedAt = Date.now();
    try {
      await connection.beginTransaction();
      const [existingRows] = await connection.execute("SELECT id FROM conversations WHERE id = ? AND user_id = ? FOR UPDATE", [id, CURRENT_USER_ID]);
      if ((existingRows as Array<{ id: string }>).length) await connection.execute("UPDATE conversations SET title = ?, updated_at = ?, project_id = ?, project_name = ? WHERE id = ? AND user_id = ?", [title, updatedAt, projectId || null, projectName || null, id, CURRENT_USER_ID]);
      else await connection.execute("INSERT INTO conversations (id, user_id, title, updated_at, project_id, project_name) VALUES (?, ?, ?, ?, ?, ?)", [id, CURRENT_USER_ID, title, updatedAt, projectId || null, projectName || null]);
      await connection.execute("DELETE FROM conversation_messages WHERE conversation_id = ?", [id]);
      for (const [index, message] of messages.entries()) {
        await connection.execute("INSERT INTO conversation_messages (conversation_id, message_index, role, content, is_error, result_json) VALUES (?, ?, ?, ?, ?, ?)", [id, index, message.role, message.content, message.error ? 1 : 0, message.result === undefined ? null : JSON.stringify(message.result)]);
      }
      await connection.commit();
      return updatedAt;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  const database = getDatabase();
  const updatedAt = Date.now();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("INSERT INTO conversations (id, user_id, title, updated_at, project_id, project_name) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at, project_id = excluded.project_id, project_name = excluded.project_name WHERE conversations.user_id = excluded.user_id").run(id, CURRENT_USER_ID, title, updatedAt, projectId || null, projectName || null);
    database.prepare("DELETE FROM conversation_messages WHERE conversation_id = ? AND EXISTS (SELECT 1 FROM conversations WHERE id = ? AND user_id = ?)").run(id, id, CURRENT_USER_ID);
    const insert = database.prepare("INSERT INTO conversation_messages (conversation_id, message_index, role, content, is_error, result_json) VALUES (?, ?, ?, ?, ?, ?)");
    messages.forEach((message, index) => insert.run(id, index, message.role, message.content, message.error ? 1 : 0, message.result === undefined ? null : JSON.stringify(message.result)));
    database.exec("COMMIT");
    return updatedAt;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export async function deleteConversation(id: string) {
  if (await getProvider() === "mysql") {
    const pool = await getMysqlPool();
    const [result] = await pool.execute("DELETE FROM conversations WHERE id = ? AND user_id = ?", [id, CURRENT_USER_ID]);
    return (result as { affectedRows: number }).affectedRows > 0;
  }
  return getDatabase().prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?").run(id, CURRENT_USER_ID).changes > 0;
}

export async function setConversationPinned(id: string, pinned: boolean) {
  if (await getProvider() === "mysql") {
    const pool = await getMysqlPool();
    const [result] = await pool.execute("UPDATE conversations SET pinned = ? WHERE id = ? AND user_id = ?", [pinned ? 1 : 0, id, CURRENT_USER_ID]);
    return (result as { affectedRows: number }).affectedRows > 0;
  }
  return getDatabase().prepare("UPDATE conversations SET pinned = ? WHERE id = ? AND user_id = ?").run(pinned ? 1 : 0, id, CURRENT_USER_ID).changes > 0;
}
