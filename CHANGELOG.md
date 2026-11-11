# 变更日志

版本号同时作用于仓库根、`apps/*` 与 `packages/*`（一个仓库一套版本）；
网关版本唯一来源是 `packages/bridge/src/version.ts`（读 `package.json`，不再手写常量）。

## v1.0.0 — 2026-11-11

第一个可用于内部试点的版本：飞书下发任务 → 员工本机 Agent 执行 → 平台统一观测。

**平台（apps/platform）**

- 绑定：6 位一次性绑定码（HMAC 存储）+ 设备令牌（SHA-256 存储），一个飞书人一个主 Agent，
  换机时新设备顶掉旧设备；支持网页授权扫码绑定。
- 投递：长轮询 + 租约 + ack，掉的设备可回收任务，不丢不重。
- 身份：绑定时同步飞书姓名 / 头像（`contact:contact.base:readonly`），
  后台可手动「同步身份」；无权限时降级为 `agent-xxxx` 并回传飞书错误码。
- 管理：禁用 / 强制下线 / 删除三档动作；删除需输入 Agent 名确认，历史任务与 trace 保留。
- trace：任务级 + 步骤级 + 聚合统计，任务记录实际执行目录。
- 迁移：schema v1 → v5（`agents.is_primary`、`runs.cwd`、`agents.feishu_avatar` 等），启动时自动升级。

**网关（packages/bridge，命令 `sa`，兼容旧名 `staff-agent`）**

- 运行时适配：`pi`（rpc）/ `claude`（stream-json）/ `codex`（exec --json），过程输出实时回传。
- 本机工作区：`sa agents add|list|update|remove`，`#名字` 指定、`#列表` 本地直接回复（不花 token）；
  工作区只存本机 `~/.staff-agent/config.json`，平台不感知。
- 配置热重载：按 config.json 的 mtime 重读，增删工作区无需重启守护进程。
- 守护进程：`sa start --daemon` / `stop` / `status` / `doctor` / `logs`。
- 分发：`pnpm bridge:link`（本仓库开发机软链）或 `pnpm bridge:pack`（tgz 分发给同事）。

**已知限制**

- 飞书长连接同一应用只能一个实例在线。
- 只处理文本消息。
- 同一 Agent 串行执行，工作区不与主 Agent 并行。
