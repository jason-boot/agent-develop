import { DatabaseSync } from "node:sqlite";
import mysql, { type Pool } from "mysql2/promise";
import fs from "node:fs";
import { chmod, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

export type StoredMessage = { role: "assistant" | "user"; content: string; error?: boolean; result?: unknown };
export type StoredConversation = { id: string; title: string; updatedAt: number; pinned: boolean; projectId?: string; projectName?: string; messages: StoredMessage[] };

const userContext = new AsyncLocalStorage<number>();
export function withUserContext<T>(userId: number, callback: () => T): T { return userContext.run(userId, callback); }
function currentUserId() { const userId = userContext.getStore(); if (!userId) throw new Error("需要登录后才能访问用户数据。"); return userId; }

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
  if (process.env.LITTLE_SUNSHINE_RUNTIME === "desktop") return { provider: "sqlite" };
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
  if (!columns.some((column) => column.name === "user_id")) database.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER NOT NULL`);
}

function ensureAppSettingsUserKey(database: DatabaseSync) {
  const columns = database.prepare("PRAGMA table_info(app_settings)").all() as Array<{ name: string; pk: number }>;
  if (columns.some((column) => column.name === "user_id" && column.pk > 0) && (columns.find((column) => column.name === "setting_key")?.pk ?? 0) > 0) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE app_settings_new (
        user_id INTEGER NOT NULL,
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
  if (!columns.some((column) => column.name === "transport_type")) database.exec("ALTER TABLE external_mcp_servers ADD COLUMN transport_type TEXT NOT NULL DEFAULT 'http'");
  if (!columns.some((column) => column.name === "command")) database.exec("ALTER TABLE external_mcp_servers ADD COLUMN command TEXT NOT NULL DEFAULT ''");
  if (!columns.some((column) => column.name === "args_json")) database.exec("ALTER TABLE external_mcp_servers ADD COLUMN args_json TEXT NOT NULL DEFAULT '[]'");
  if (!columns.some((column) => column.name === "env_json")) database.exec("ALTER TABLE external_mcp_servers ADD COLUMN env_json TEXT NOT NULL DEFAULT '{}'");
  if (!columns.some((column) => column.name === "cwd")) database.exec("ALTER TABLE external_mcp_servers ADD COLUMN cwd TEXT NOT NULL DEFAULT ''");
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
    global.dqConversationDb.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1,
        token_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_identities (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, provider_user_id TEXT NOT NULL, provider_username TEXT NOT NULL DEFAULT '',
        provider_display_name TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        UNIQUE (provider, provider_user_id), UNIQUE (user_id, provider)
      );
    `);
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
        user_id INTEGER NOT NULL,
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
        user_id INTEGER NOT NULL,
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
        user_id INTEGER NOT NULL,
        setting_key TEXT NOT NULL,
        setting_value TEXT,
        PRIMARY KEY (user_id, setting_key)
      );
      CREATE TABLE IF NOT EXISTS external_mcp_servers (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        transport_type TEXT NOT NULL DEFAULT 'http',
        url TEXT NOT NULL,
        token TEXT NOT NULL,
        command TEXT NOT NULL DEFAULT '',
        args_json TEXT NOT NULL DEFAULT '[]',
        env_json TEXT NOT NULL DEFAULT '{}',
        cwd TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL,
        disabled_tools_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_metadata (
        metadata_key TEXT PRIMARY KEY,
        metadata_value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        token_version INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_identities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        provider_username TEXT NOT NULL DEFAULT '',
        provider_display_name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE (provider, provider_user_id),
        UNIQUE (user_id, provider)
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
      `CREATE TABLE IF NOT EXISTS conversations (id VARCHAR(128) PRIMARY KEY, user_id BIGINT NOT NULL, title TEXT NOT NULL, updated_at BIGINT NOT NULL, project_id VARCHAR(128) NULL, project_name TEXT NULL, pinned TINYINT NOT NULL DEFAULT 0) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS conversation_messages (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, conversation_id VARCHAR(128) NOT NULL, message_index INT NOT NULL, role VARCHAR(32) NOT NULL, content LONGTEXT NOT NULL, is_error TINYINT NOT NULL DEFAULT 0, result_json LONGTEXT NULL, UNIQUE KEY conversation_message_order (conversation_id, message_index), CONSTRAINT conversation_messages_fk FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS model_configs (id VARCHAR(128) PRIMARY KEY, user_id BIGINT NOT NULL, name VARCHAR(255) NOT NULL, protocol VARCHAR(32) NOT NULL, base_url TEXT NOT NULL, full_address TINYINT NOT NULL, model TEXT NOT NULL, api_key TEXT NOT NULL, vendor VARCHAR(128) NOT NULL DEFAULT 'custom', models_url TEXT NOT NULL, sort_order INT NOT NULL DEFAULT 0) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS app_settings (user_id BIGINT NOT NULL, setting_key VARCHAR(128) NOT NULL, setting_value TEXT NULL, PRIMARY KEY (user_id, setting_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS external_mcp_servers (id VARCHAR(128) PRIMARY KEY, user_id BIGINT NOT NULL, name VARCHAR(255) NOT NULL, transport_type VARCHAR(16) NOT NULL DEFAULT 'http', url TEXT NOT NULL, token TEXT NOT NULL, command TEXT NULL, args_json LONGTEXT NULL, env_json LONGTEXT NULL, cwd TEXT NULL, enabled TINYINT NOT NULL, disabled_tools_json LONGTEXT NOT NULL, allowed_tools_json LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS app_metadata (metadata_key VARCHAR(128) PRIMARY KEY, metadata_value TEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS users (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE, password_hash VARCHAR(256) NOT NULL, password_salt VARCHAR(128) NOT NULL, is_active TINYINT NOT NULL DEFAULT 1, token_version INT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS user_identities (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id BIGINT NOT NULL, provider VARCHAR(32) NOT NULL, provider_user_id VARCHAR(128) NOT NULL, provider_username VARCHAR(191) NOT NULL DEFAULT '', provider_display_name VARCHAR(191) NOT NULL DEFAULT '', avatar_url TEXT NOT NULL, created_at BIGINT NOT NULL, UNIQUE KEY identity_provider_user (provider, provider_user_id), UNIQUE KEY identity_user_provider (user_id, provider), CONSTRAINT user_identities_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ];
    for (const statement of statements) await pool.query(statement);
    const [columns] = await pool.query("SHOW COLUMNS FROM external_mcp_servers");
    const columnNames = new Set((columns as Array<{ Field: string }>).map((column) => column.Field));
    const additions = [
      ["transport_type", "VARCHAR(16) NOT NULL DEFAULT 'http'"],
      ["command", "TEXT NULL"],
      ["args_json", "LONGTEXT NULL"],
      ["env_json", "LONGTEXT NULL"],
      ["cwd", "TEXT NULL"],
    ] as const;
    for (const [name, definition] of additions) if (!columnNames.has(name)) await pool.query(`ALTER TABLE external_mcp_servers ADD COLUMN ${name} ${definition}`);
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
  if (process.env.LITTLE_SUNSHINE_RUNTIME === "desktop") return "sqlite";
  return (await readDatabaseConfig()).provider || "sqlite";
}

export type AppUser = { id: number; username: string; passwordHash: string; passwordSalt: string; isActive: boolean; tokenVersion: number; createdAt: number };
export type UserIdentity = { provider: string; providerUserId: string; providerUsername: string; providerDisplayName: string; avatarUrl: string; createdAt: number };

function mapUser(row: { id: number | string; username: string; passwordHash: string; passwordSalt: string; isActive: number; tokenVersion: number; createdAt: number | string }): AppUser {
  return { id: Number(row.id), username: row.username, passwordHash: row.passwordHash, passwordSalt: row.passwordSalt, isActive: Boolean(row.isActive), tokenVersion: Number(row.tokenVersion), createdAt: Number(row.createdAt) };
}

export async function findUserByUsername(username: string): Promise<AppUser | null> {
  const sql = "SELECT id, username, password_hash AS passwordHash, password_salt AS passwordSalt, is_active AS isActive, token_version AS tokenVersion, created_at AS createdAt FROM users WHERE username = ? LIMIT 1";
  if (await getProvider() === "mysql") {
    const [rows] = await (await getMysqlPool()).execute(sql, [username]);
    const row = (rows as Array<Parameters<typeof mapUser>[0]>)[0];
    return row ? mapUser(row) : null;
  }
  const row = getDatabase().prepare(sql).get(username) as Parameters<typeof mapUser>[0] | undefined;
  return row ? mapUser(row) : null;
}

export async function findUserById(id: number): Promise<AppUser | null> {
  const sql = "SELECT id, username, password_hash AS passwordHash, password_salt AS passwordSalt, is_active AS isActive, token_version AS tokenVersion, created_at AS createdAt FROM users WHERE id = ? LIMIT 1";
  if (await getProvider() === "mysql") {
    const [rows] = await (await getMysqlPool()).execute(sql, [id]);
    const row = (rows as Array<Parameters<typeof mapUser>[0]>)[0];
    return row ? mapUser(row) : null;
  }
  const row = getDatabase().prepare(sql).get(id) as Parameters<typeof mapUser>[0] | undefined;
  return row ? mapUser(row) : null;
}

export async function findUserByIdentity(provider: string, providerUserId: string) {
  const sql = "SELECT u.id, u.username, u.password_hash AS passwordHash, u.password_salt AS passwordSalt, u.is_active AS isActive, u.token_version AS tokenVersion, u.created_at AS createdAt FROM users u JOIN user_identities i ON i.user_id = u.id WHERE i.provider = ? AND i.provider_user_id = ? LIMIT 1";
  if (await getProvider() === "mysql") {
    const [rows] = await (await getMysqlPool()).execute(sql, [provider, providerUserId]);
    const row = (rows as Array<Parameters<typeof mapUser>[0]>)[0];
    return row ? mapUser(row) : null;
  }
  const row = getDatabase().prepare(sql).get(provider, providerUserId) as Parameters<typeof mapUser>[0] | undefined;
  return row ? mapUser(row) : null;
}

export async function listUserIdentities(userId: number): Promise<UserIdentity[]> {
  const sql = "SELECT provider, provider_user_id AS providerUserId, provider_username AS providerUsername, provider_display_name AS providerDisplayName, avatar_url AS avatarUrl, created_at AS createdAt FROM user_identities WHERE user_id = ? ORDER BY provider";
  if (await getProvider() === "mysql") {
    const [rows] = await (await getMysqlPool()).execute(sql, [userId]);
    return (rows as Array<UserIdentity & { createdAt: number | string }>).map((row) => ({ ...row, createdAt: Number(row.createdAt) }));
  }
  return getDatabase().prepare(sql).all(userId) as UserIdentity[];
}

async function movePreviouslyClaimedGithubData(userId: number, readOwner: () => Promise<string | undefined>, execute: (sql: string, values?: Array<string | number>) => Promise<void>) {
  const oldOwner = Number(await readOwner());
  if (!Number.isSafeInteger(oldOwner) || oldOwner <= 1 || oldOwner === userId) return;
  for (const table of ["conversations", "model_configs", "external_mcp_servers", "app_settings"]) await execute(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`, [userId, oldOwner]);
  await execute("UPDATE app_metadata SET metadata_value = 'migrated' WHERE metadata_key = 'github_legacy_data_claimed'");
}

export async function createLocalUser(username: string, passwordHash: string, passwordSalt: string): Promise<AppUser> {
  const createdAt = Date.now();
  if (await getProvider() === "mysql") {
    const pool = await getMysqlPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute("INSERT INTO users (username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?)", [username, passwordHash, passwordSalt, createdAt]);
      const id = Number((result as { insertId: number | string }).insertId);
      await movePreviouslyClaimedGithubData(id, async () => {
        const [rows] = await connection.execute("SELECT metadata_value FROM app_metadata WHERE metadata_key = 'github_legacy_data_claimed' FOR UPDATE");
        return (rows as Array<{ metadata_value: string }>)[0]?.metadata_value;
      }, async (sql, values = []) => { await connection.execute(sql, values); });
      await connection.commit();
      return { id, username, passwordHash, passwordSalt, isActive: true, tokenVersion: 0, createdAt };
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database.prepare("INSERT INTO users (username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?)").run(username, passwordHash, passwordSalt, createdAt);
    const id = Number(result.lastInsertRowid);
    const oldOwner = Number((database.prepare("SELECT metadata_value FROM app_metadata WHERE metadata_key = 'github_legacy_data_claimed'").get() as { metadata_value?: string } | undefined)?.metadata_value);
    if (Number.isSafeInteger(oldOwner) && oldOwner > 1 && oldOwner !== id) {
      for (const table of ["conversations", "model_configs", "external_mcp_servers", "app_settings"]) database.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`).run(id, oldOwner);
      database.prepare("UPDATE app_metadata SET metadata_value = 'migrated' WHERE metadata_key = 'github_legacy_data_claimed'").run();
    }
    database.exec("COMMIT");
    return { id, username, passwordHash, passwordSalt, isActive: true, tokenVersion: 0, createdAt };
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

export async function bindUserIdentity(userId: number, identity: UserIdentity) {
  if (await getProvider() === "mysql") {
    const pool = await getMysqlPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [ownerRows] = await connection.execute("SELECT user_id FROM user_identities WHERE provider = ? AND provider_user_id = ? FOR UPDATE", [identity.provider, identity.providerUserId]);
      const owner = (ownerRows as Array<{ user_id: number | string }>)[0];
      if (owner && Number(owner.user_id) !== userId) throw new Error("该第三方账号已绑定到其他用户。");
      const [userRows] = await connection.execute("SELECT id, provider_user_id FROM user_identities WHERE user_id = ? AND provider = ? FOR UPDATE", [userId, identity.provider]);
      const prior = (userRows as Array<{ id: number; provider_user_id: string }>)[0];
      if (prior) {
        if (prior.provider_user_id !== identity.providerUserId) throw new Error("该用户已绑定此平台的其他账号。");
        await connection.execute("UPDATE user_identities SET provider_username = ?, provider_display_name = ?, avatar_url = ? WHERE id = ?", [identity.providerUsername, identity.providerDisplayName, identity.avatarUrl, prior.id]);
      }
      else await connection.execute("INSERT INTO user_identities (user_id, provider, provider_user_id, provider_username, provider_display_name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [userId, identity.provider, identity.providerUserId, identity.providerUsername, identity.providerDisplayName, identity.avatarUrl, identity.createdAt]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    return;
  }
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const owner = database.prepare("SELECT user_id FROM user_identities WHERE provider = ? AND provider_user_id = ?").get(identity.provider, identity.providerUserId) as { user_id: number } | undefined;
    if (owner && Number(owner.user_id) !== userId) throw new Error("该第三方账号已绑定到其他用户。");
    const prior = database.prepare("SELECT id, provider_user_id FROM user_identities WHERE user_id = ? AND provider = ?").get(userId, identity.provider) as { id: number; provider_user_id: string } | undefined;
    if (prior) {
      if (prior.provider_user_id !== identity.providerUserId) throw new Error("该用户已绑定此平台的其他账号。");
      database.prepare("UPDATE user_identities SET provider_username = ?, provider_display_name = ?, avatar_url = ? WHERE id = ?").run(identity.providerUsername, identity.providerDisplayName, identity.avatarUrl, prior.id);
    }
    else database.prepare("INSERT INTO user_identities (user_id, provider, provider_user_id, provider_username, provider_display_name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(userId, identity.provider, identity.providerUserId, identity.providerUsername, identity.providerDisplayName, identity.avatarUrl, identity.createdAt);
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

export async function removeUserIdentity(userId: number, provider: string) {
  const sql = "DELETE FROM user_identities WHERE user_id = ? AND provider = ?";
  if (await getProvider() === "mysql") {
    const [result] = await (await getMysqlPool()).execute(sql, [userId, provider]);
    return Number((result as { affectedRows: number }).affectedRows) > 0;
  }
  return getDatabase().prepare(sql).run(userId, provider).changes > 0;
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
            await connection.execute("INSERT IGNORE INTO model_configs (id, user_id, name, protocol, base_url, full_address, model, api_key, vendor, models_url, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'custom', '', ?)", [item.id, currentUserId(), item.name, protocol, item.baseUrl, item.fullAddress === undefined ? (inferredFullAddress ? 1 : 0) : item.fullAddress ? 1 : 0, item.model, typeof item.apiKey === "string" ? item.apiKey : "", index]);
          }
          const defaultId = typeof models?.defaultModelId === "string" ? models.defaultModelId : null;
          await connection.execute("INSERT INTO app_settings (user_id, setting_key, setting_value) VALUES (?, 'default_model_id', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [currentUserId(), defaultId]);
          await connection.execute("INSERT IGNORE INTO app_metadata (metadata_key, metadata_value) VALUES ('models_json_v1', 'done')");
        }
        if (!migrated.has("external_mcp_json_v1")) {
          for (const item of (Array.isArray(external?.servers) ? external.servers : [])) {
            if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.url !== "string") continue;
            await connection.execute("INSERT IGNORE INTO external_mcp_servers (id, user_id, name, url, token, enabled, disabled_tools_json, allowed_tools_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [item.id, currentUserId(), item.name, item.url, typeof item.token === "string" ? item.token : "", item.enabled === false ? 0 : 1, JSON.stringify(Array.isArray(item.disabledTools) ? item.disabledTools.filter((name): name is string => typeof name === "string") : []), JSON.stringify(Array.isArray(item.allowedTools) ? item.allowedTools.filter((name): name is string => typeof name === "string") : [])]);
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
          insertModel.run(item.id, currentUserId(), item.name, protocol, item.baseUrl, item.fullAddress === undefined ? (inferredFullAddress ? 1 : 0) : item.fullAddress ? 1 : 0, item.model, typeof item.apiKey === "string" ? item.apiKey : "", index);
        }
        const defaultId = typeof models?.defaultModelId === "string" ? models.defaultModelId : null;
        database.prepare("INSERT INTO app_settings (user_id, setting_key, setting_value) VALUES (?, 'default_model_id', ?) ON CONFLICT(user_id, setting_key) DO UPDATE SET setting_value = excluded.setting_value").run(currentUserId(), defaultId);
        database.prepare("INSERT INTO app_metadata (metadata_key, metadata_value) VALUES ('models_json_v1', 'done')").run();
      }
      if (!migrated.get("external_mcp_json_v1")) {
        const insertServer = database.prepare("INSERT OR IGNORE INTO external_mcp_servers (id, user_id, name, url, token, enabled, disabled_tools_json, allowed_tools_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        for (const item of (Array.isArray(external?.servers) ? external.servers : [])) {
          if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.url !== "string") continue;
          insertServer.run(item.id, currentUserId(), item.name, item.url, typeof item.token === "string" ? item.token : "", item.enabled === false ? 0 : 1, JSON.stringify(Array.isArray(item.disabledTools) ? item.disabledTools.filter((name): name is string => typeof name === "string") : []), JSON.stringify(Array.isArray(item.allowedTools) ? item.allowedTools.filter((name): name is string => typeof name === "string") : []));
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
    const [rows] = await pool.execute("SELECT id, name, protocol, base_url AS baseUrl, full_address AS fullAddress, model, api_key AS apiKey, vendor, models_url AS modelsUrl FROM model_configs WHERE user_id = ? ORDER BY sort_order, id", [currentUserId()]);
    const [defaultRows] = await pool.execute("SELECT setting_value FROM app_settings WHERE user_id = ? AND setting_key = 'default_model_id'", [currentUserId()]);
    const defaultRow = (defaultRows as Array<{ setting_value: string | null }>)[0];
    return { models: (rows as Array<{ id: string; name: string; protocol: "chat" | "messages" | "responses"; baseUrl: string; fullAddress: number; model: string; apiKey: string; vendor: string; modelsUrl: string }>).map((row) => ({ ...row, fullAddress: Boolean(row.fullAddress) })), defaultModelId: defaultRow?.setting_value || null };
  }
  const database = getDatabase();
  const rows = database.prepare("SELECT id, name, protocol, base_url AS baseUrl, full_address AS fullAddress, model, api_key AS apiKey, vendor, models_url AS modelsUrl FROM model_configs WHERE user_id = ? ORDER BY sort_order, rowid").all(currentUserId()) as Array<{ id: string; name: string; protocol: "chat" | "messages" | "responses"; baseUrl: string; fullAddress: number; model: string; apiKey: string; vendor: string; modelsUrl: string }>;
  const defaultRow = database.prepare("SELECT setting_value FROM app_settings WHERE user_id = ? AND setting_key = 'default_model_id'").get(currentUserId()) as { setting_value: string | null } | undefined;
  return { models: rows.map((row) => ({ ...row, fullAddress: Boolean(row.fullAddress) })), defaultModelId: defaultRow?.setting_value || null };
}

export async function writeModelConfigStore(store: { models: Array<{ id: string; name: string; protocol: string; baseUrl: string; fullAddress: boolean; model: string; apiKey: string; vendor?: string; modelsUrl?: string }>; defaultModelId: string | null }) {
  if (await getProvider() === "mysql") {
    const pool = await getMysqlPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("DELETE FROM model_configs WHERE user_id = ?", [currentUserId()]);
      for (const [index, model] of store.models.entries()) {
        await connection.execute("INSERT INTO model_configs (id, user_id, name, protocol, base_url, full_address, model, api_key, vendor, models_url, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [model.id, currentUserId(), model.name, model.protocol, model.baseUrl, model.fullAddress ? 1 : 0, model.model, model.apiKey, model.vendor || "custom", model.modelsUrl || "", index]);
      }
      await connection.execute("INSERT INTO app_settings (user_id, setting_key, setting_value) VALUES (?, 'default_model_id', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [currentUserId(), store.defaultModelId]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    return;
  }
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM model_configs WHERE user_id = ?").run(currentUserId());
    const insert = database.prepare("INSERT INTO model_configs (id, user_id, name, protocol, base_url, full_address, model, api_key, vendor, models_url, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    store.models.forEach((model, index) => insert.run(model.id, currentUserId(), model.name, model.protocol, model.baseUrl, model.fullAddress ? 1 : 0, model.model, model.apiKey, model.vendor || "custom", model.modelsUrl || "", index));
    database.prepare("INSERT INTO app_settings (user_id, setting_key, setting_value) VALUES (?, 'default_model_id', ?) ON CONFLICT(user_id, setting_key) DO UPDATE SET setting_value = excluded.setting_value").run(currentUserId(), store.defaultModelId);
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

export async function readExternalMcpConfig() {
  const mapRow = (row: { id: string; name: string; transport: string | null; url: string; token: string; command: string | null; argsJson: string | null; envJson: string | null; cwd: string | null; enabled: number; disabledToolsJson: string; allowedToolsJson: string }) => ({
    id: row.id, name: row.name, transport: row.transport === "stdio" ? "stdio" as const : "http" as const, url: row.url || "", token: row.token || "",
    command: row.command || "", args: JSON.parse(row.argsJson || "[]") as string[], env: JSON.parse(row.envJson || "{}") as Record<string, string>, cwd: row.cwd || "",
    enabled: Boolean(row.enabled), disabledTools: JSON.parse(row.disabledToolsJson) as string[], allowedTools: JSON.parse(row.allowedToolsJson) as string[],
  });
  const select = "SELECT id, name, transport_type AS transport, url, token, command, args_json AS argsJson, env_json AS envJson, cwd, enabled, disabled_tools_json AS disabledToolsJson, allowed_tools_json AS allowedToolsJson FROM external_mcp_servers";
  if (await getProvider() === "mysql") {
    const pool = await getMysqlPool();
    const [rows] = await pool.execute(`${select} WHERE user_id = ? ORDER BY id`, [currentUserId()]);
    return { servers: (rows as Array<Parameters<typeof mapRow>[0]>).map(mapRow) };
  }
  const rows = getDatabase().prepare(`${select} WHERE user_id = ? ORDER BY rowid`).all(currentUserId()) as Array<Parameters<typeof mapRow>[0]>;
  return { servers: rows.map(mapRow) };
}

export async function writeExternalMcpConfig(store: { servers: Array<{ id: string; name: string; transport: "http" | "stdio"; url: string; token: string; command: string; args: string[]; env: Record<string, string>; cwd: string; enabled: boolean; disabledTools: string[]; allowedTools: string[] }> }) {
  const insertSql = "INSERT INTO external_mcp_servers (id, user_id, name, transport_type, url, token, command, args_json, env_json, cwd, enabled, disabled_tools_json, allowed_tools_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
  const values = (server: typeof store.servers[number]) => [server.id, currentUserId(), server.name, server.transport, server.url, server.token, server.command, JSON.stringify(server.args), JSON.stringify(server.env), server.cwd, server.enabled ? 1 : 0, JSON.stringify(server.disabledTools), JSON.stringify(server.allowedTools)];
  if (await getProvider() === "mysql") {
    const pool = await getMysqlPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("DELETE FROM external_mcp_servers WHERE user_id = ?", [currentUserId()]);
      for (const server of store.servers) {
        await connection.execute(insertSql, values(server));
      }
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    return;
  }
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM external_mcp_servers WHERE user_id = ?").run(currentUserId());
    const insert = database.prepare(insertSql);
    store.servers.forEach((server) => insert.run(...values(server)));
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

export async function listConversations() {
  if (await getProvider() === "mysql") {
    const pool = await getMysqlPool();
    const [rows] = await pool.execute("SELECT id, title, updated_at AS updatedAt, pinned, project_id AS projectId, project_name AS projectName FROM conversations WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC", [currentUserId()]);
    return (rows as Array<{ id: string; title: string; updatedAt: number; pinned: number; projectId: string | null; projectName: string | null }>).map((row) => ({ ...row, pinned: Boolean(row.pinned) }));
  }
  return (getDatabase().prepare("SELECT id, title, updated_at AS updatedAt, pinned, project_id AS projectId, project_name AS projectName FROM conversations WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC").all(currentUserId()) as Array<{ id: string; title: string; updatedAt: number; pinned: number; projectId: string | null; projectName: string | null }>).map((row) => ({ ...row, pinned: Boolean(row.pinned) }));
}

export async function getConversation(id: string): Promise<StoredConversation | null> {
  if (await getProvider() === "mysql") {
    const pool = await getMysqlPool();
    const [conversationRows] = await pool.execute("SELECT id, title, updated_at AS updatedAt, pinned, project_id AS projectId, project_name AS projectName FROM conversations WHERE id = ? AND user_id = ?", [id, currentUserId()]);
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
  const row = database.prepare("SELECT id, title, updated_at AS updatedAt, pinned, project_id AS projectId, project_name AS projectName FROM conversations WHERE id = ? AND user_id = ?").get(id, currentUserId()) as { id: string; title: string; updatedAt: number; pinned: number; projectId: string | null; projectName: string | null } | undefined;
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
      const [existingRows] = await connection.execute("SELECT id FROM conversations WHERE id = ? AND user_id = ? FOR UPDATE", [id, currentUserId()]);
      if ((existingRows as Array<{ id: string }>).length) await connection.execute("UPDATE conversations SET title = ?, updated_at = ?, project_id = ?, project_name = ? WHERE id = ? AND user_id = ?", [title, updatedAt, projectId || null, projectName || null, id, currentUserId()]);
      else await connection.execute("INSERT INTO conversations (id, user_id, title, updated_at, project_id, project_name) VALUES (?, ?, ?, ?, ?, ?)", [id, currentUserId(), title, updatedAt, projectId || null, projectName || null]);
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
    database.prepare("INSERT INTO conversations (id, user_id, title, updated_at, project_id, project_name) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at, project_id = excluded.project_id, project_name = excluded.project_name WHERE conversations.user_id = excluded.user_id").run(id, currentUserId(), title, updatedAt, projectId || null, projectName || null);
    database.prepare("DELETE FROM conversation_messages WHERE conversation_id = ? AND EXISTS (SELECT 1 FROM conversations WHERE id = ? AND user_id = ?)").run(id, id, currentUserId());
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
    const [result] = await pool.execute("DELETE FROM conversations WHERE id = ? AND user_id = ?", [id, currentUserId()]);
    return (result as { affectedRows: number }).affectedRows > 0;
  }
  return getDatabase().prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?").run(id, currentUserId()).changes > 0;
}

export async function setConversationPinned(id: string, pinned: boolean) {
  if (await getProvider() === "mysql") {
    const pool = await getMysqlPool();
    const [result] = await pool.execute("UPDATE conversations SET pinned = ? WHERE id = ? AND user_id = ?", [pinned ? 1 : 0, id, currentUserId()]);
    return (result as { affectedRows: number }).affectedRows > 0;
  }
  return getDatabase().prepare("UPDATE conversations SET pinned = ? WHERE id = ? AND user_id = ?").run(pinned ? 1 : 0, id, currentUserId()).changes > 0;
}
