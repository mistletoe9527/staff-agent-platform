import type { Db } from '../db/client.js';
import { newId, nowIso } from '../util/ids.js';

/** 会话实体：一段飞书上下文对应一个运行时 session，实现多轮续聊。 */
export interface Conversation {
  id: string;
  agentId: string;
  feishuChatId: string;
  feishuChatType: string;
  feishuThreadId: string;
  sessionRef: string | null;
  lastActiveAt: string;
  createdAt: string;
}

interface ConversationRow {
  id: string;
  agent_id: string;
  feishu_chat_id: string;
  feishu_chat_type: string;
  feishu_thread_id: string;
  session_ref: string | null;
  last_active_at: string;
  created_at: string;
}

/** 行转实体。 */
function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    agentId: row.agent_id,
    feishuChatId: row.feishu_chat_id,
    feishuChatType: row.feishu_chat_type,
    feishuThreadId: row.feishu_thread_id,
    sessionRef: row.session_ref,
    lastActiveAt: row.last_active_at,
    createdAt: row.created_at,
  };
}

/**
 * 取或建会话。thread_id 用空串代替 NULL，保证唯一索引对「群内普通消息」也生效。
 */
export function upsertConversation(
  db: Db,
  input: { agentId: string; feishuChatId: string; feishuChatType: string; feishuThreadId: string | null },
): Conversation {
  const threadId = input.feishuThreadId ?? '';
  const existing = db
    .prepare(
      'SELECT * FROM conversations WHERE agent_id = ? AND feishu_chat_id = ? AND feishu_thread_id = ?',
    )
    .get(input.agentId, input.feishuChatId, threadId) as unknown as ConversationRow | undefined;
  if (existing) {
    db.prepare('UPDATE conversations SET last_active_at = ? WHERE id = ?').run(nowIso(), existing.id);
    return toConversation({ ...existing, last_active_at: nowIso() });
  }
  const id = newId('cnv');
  const now = nowIso();
  db.prepare(
    `INSERT INTO conversations (id, agent_id, feishu_chat_id, feishu_chat_type, feishu_thread_id, session_ref, last_active_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(id, input.agentId, input.feishuChatId, input.feishuChatType, threadId, now, now);
  return {
    id,
    agentId: input.agentId,
    feishuChatId: input.feishuChatId,
    feishuChatType: input.feishuChatType,
    feishuThreadId: threadId,
    sessionRef: null,
    lastActiveAt: now,
    createdAt: now,
  };
}

/** 记录运行时返回的会话标识，下一轮任务据此续聊。 */
export function updateConversationSession(db: Db, conversationId: string, sessionRef: string | null): void {
  db.prepare('UPDATE conversations SET session_ref = ?, last_active_at = ? WHERE id = ?').run(
    sessionRef,
    nowIso(),
    conversationId,
  );
}
