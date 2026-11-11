import { openDatabase } from './client.js';
import { ensureSchema } from './migrations.js';

/**
 * 数据库迁移命令行。
 * 独立于平台启动路径，便于交付时先建库再做数据审计。
 * 用法：DATA_DIR=./data pnpm --filter @staff-agent/platform migrate
 */
const dataDir = process.env.DATA_DIR ?? './data';
const db = openDatabase(dataDir);
const applied = ensureSchema(db);
if (applied.length === 0) {
  process.stdout.write(JSON.stringify({ ok: true, dataDir, applied: [], message: '没有待应用的迁移' }) + '\n');
} else {
  process.stdout.write(JSON.stringify({ ok: true, dataDir, applied }) + '\n');
}
db.close();
