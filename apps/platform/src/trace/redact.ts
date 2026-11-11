/**
 * trace 脱敏。
 * trace 会记录员工让 Agent 干的原话和工具入参，可能包含密钥、令牌、连接串。
 * 平台必须默认脱敏，不能把凭证写进可被管理员翻看的表。
 */

/** 需要脱敏的模式，按顺序应用。 */
const PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // OpenAI / Anthropic / DeepSeek 风格密钥
  { pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replacement: 'sk-***' },
  // 阿里云 AccessKey
  { pattern: /\bLTAI[A-Za-z0-9]{10,}\b/g, replacement: 'LTAI***' },
  // AWS AccessKey
  { pattern: /\bAKIA[A-Z0-9]{12,}\b/g, replacement: 'AKIA***' },
  // Bearer token
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, replacement: 'Bearer ***' },
  // key=value / key: value 形式的敏感字段
  {
    pattern: /\b(api[_-]?key|access[_-]?token|secret|password|passwd|pwd|token|authorization)\b\s*[:=]\s*("[^"]{4,}"|'[^']{4,}'|[^\s,;)"']{4,})/gi,
    replacement: '$1=***',
  },
  // 数据库连接串里的密码
  { pattern: /(:\/\/[^:/\s]+):([^@/\s]+)@/g, replacement: '$1:***@' },
  // 私钥块
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '-----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----',
  },
];

/**
 * 脱敏并截断。
 * @param text 原始文本
 * @param maxChars 最大保留字符数，超出部分用省略标记
 */
export function redact(text: string | null | undefined, maxChars: number): string | null {
  if (text === null || text === undefined) return null;
  let output = text;
  for (const { pattern, replacement } of PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  if (output.length > maxChars) {
    output = `${output.slice(0, maxChars)}…[truncated ${output.length - maxChars} chars]`;
  }
  return output;
}
