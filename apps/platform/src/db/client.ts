import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 数据库文件名。单文件便于私有化部署备份（复制即备份）。 */
const DB_FILE = 'staff-agent.db';

/**
 * 打开 SQLite 数据库。
 * 使用 Node 内置 node:sqlite，零原生依赖，docker 镜像不需要编译工具链。
 */
export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, DB_FILE));
  // WAL 让读不阻塞写；500 台网关的心跳写压力远低于 SQLite 单写者上限
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** 数据库实例类型别名，方便在 repository 中复用。 */
export type Db = DatabaseSync;
