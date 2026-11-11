import type { Db } from './client.js';

/**
 * 迁移脚本列表。
 * 规则：只追加，不修改已发布的版本；SQL 不使用 IF NOT EXISTS，由 schema_migrations 保证只执行一次。
 */
interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  feishu_open_id TEXT NOT NULL UNIQUE,
  feishu_name TEXT,
  name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  machine_id TEXT NOT NULL,
  machine_name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  runtime_version TEXT,
  bridge_version TEXT,
  token_hash TEXT UNIQUE,
  status TEXT NOT NULL,
  bridge_state TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_devices_agent ON devices (agent_id);
CREATE INDEX idx_devices_machine ON devices (machine_id);

CREATE TABLE enroll_codes (
  code_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  pending_token TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_enroll_codes_device ON enroll_codes (device_id);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  feishu_chat_id TEXT NOT NULL,
  feishu_chat_type TEXT NOT NULL,
  feishu_thread_id TEXT NOT NULL,
  session_ref TEXT,
  last_active_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_conversations_key ON conversations (agent_id, feishu_chat_id, feishu_thread_id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_expires_at TEXT,
  result TEXT,
  error TEXT,
  duration_ms INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  session_ref TEXT,
  feishu_chat_id TEXT NOT NULL,
  feishu_message_id TEXT,
  created_by_open_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX idx_runs_agent_status ON runs (agent_id, status, created_at);
CREATE INDEX idx_runs_created ON runs (created_at);
CREATE INDEX idx_runs_lease ON runs (status, lease_expires_at);

CREATE TABLE steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  is_error INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_steps_run_seq ON steps (run_id, seq);
CREATE INDEX idx_steps_type ON steps (type, created_at);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_logs (created_at);
`,
  },
  {
    version: 2,
    name: 'agent-workspaces',
    // 一个飞书人可以有多台/多个 Agent：主 Agent 绑定时创建，其余在客户端新增。
    // SQLite 改不了列上的 UNIQUE，只能重建表；旧数据里每个用户只有一个 Agent，全部标为主 Agent。
    sql: `
CREATE TABLE agents_v2 (
  id TEXT PRIMARY KEY,
  feishu_open_id TEXT NOT NULL,
  feishu_name TEXT,
  name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  status TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  device_id TEXT,
  cwd TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO agents_v2 (id, feishu_open_id, feishu_name, name, runtime, status, is_primary, device_id, cwd, description, created_at, updated_at)
SELECT a.id, a.feishu_open_id, a.feishu_name, a.name, a.runtime, a.status, 1,
       (SELECT d.id FROM devices d
         WHERE d.agent_id = a.id AND d.status = 'active'
         ORDER BY COALESCE(d.last_seen_at, '') DESC LIMIT 1),
       NULL, NULL, a.created_at, a.updated_at
FROM agents a;

DROP TABLE agents;
ALTER TABLE agents_v2 RENAME TO agents;

CREATE INDEX idx_agents_open_id ON agents (feishu_open_id);
CREATE INDEX idx_agents_device ON agents (device_id);
-- 每个飞书人只能有一个主 Agent
CREATE UNIQUE INDEX idx_agents_primary ON agents (feishu_open_id) WHERE is_primary = 1;
`,
  },
  {
    version: 3,
    name: 'run-cwd',
    // 任务可能被派到某个子工作区执行，把实际工作目录记在任务上，便于追溯与重放
    sql: `ALTER TABLE runs ADD COLUMN cwd TEXT;`,
  },
  {
    version: 4,
    name: 'feishu-avatar',
    // 绑定后把飞书头像也同步过来，后台一眼能认出是谁的数字员工；拿不到权限时留空
    sql: `ALTER TABLE agents ADD COLUMN feishu_avatar TEXT;`,
  },
  {
    version: 5,
    name: 'local-workspaces',
    // 子 Agent 下沉到员工本机：平台只保留主 Agent（数字员工），
    // 存量子 Agent 记录的 cwd 是本机路径，对平台没有任何价值，直接清掉。
    sql: `
DELETE FROM agents WHERE is_primary = 0;
DROP INDEX IF EXISTS idx_agents_device;
`,
  },
];

/**
 * 执行所有未应用的迁移。每个迁移单独事务，失败即回滚。
 * @returns 本次应用的版本号列表
 */
export function migrate(db: Db): number[] {
  db.exec(`
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
)
`);
  return applyPending(db);
}

/**
 * 应用尚未执行的迁移（schema_migrations 已存在时使用）。
 */
export function applyPending(db: Db): number[] {
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as unknown as Array<{ version: number }>;
  const applied = new Set(rows.map((row) => row.version));
  const appliedNow: number[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      appliedNow.push(migration.version);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return appliedNow;
}

/**
 * 启动时调用：确保 schema_migrations 存在（首次创建），然后补齐迁移。
 * 与 migrate 的差别是不重复建表，供服务启动路径使用。
 */
export function ensureSchema(db: Db): number[] {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name?: string } | undefined;
  if (!table?.name) {
    return migrate(db);
  }
  return applyPending(db);
}
