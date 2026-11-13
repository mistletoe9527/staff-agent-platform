# 变更日志

版本号同时作用于仓库根、`apps/*` 与 `packages/*`（一个仓库一套版本）；
网关版本唯一来源是 `packages/bridge/src/version.ts`（读 `package.json`，不再手写常量）。

## Unreleased

**网关：Windows 可执行文件解析**

- 修复 Windows 上 `sa doctor` / 任务启动报 `spawn pi|claude|codex ENOENT`：npm 全局安装会同时装
  `codex`（Git Bash 的 sh 脚本）、`codex.cmd`、`codex.ps1`，原来按原名优先挑到了 sh 脚本，
  CreateProcess 起不来；现在先按 PATHEXT 找 `.exe/.cmd/.bat`，无扩展名文件必须是真 PE 才认。
- `.cmd` / `.bat` 改经 `cmd.exe` 启动（`shell: true`），`--version` 探测同样走 shell。
- 终止子进程改用 `taskkill /T /F` 收整棵进程树，避免 cmd shim 下面的 node 子进程残留。
- 兜底搜索目录补上 `%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm`、WinGet Links 等 Windows 路径。

**Skill 广场**

- 后台新增「Skill 广场」：员工用飞书网页授权登录后上传 / 下载可复用 Skill；管理员口令登录可管理全部 Skill。
- 支持 zip、单个 `SKILL.md`、浏览器选择文件夹上传；服务端规范化包结构（根目录必须有 `SKILL.md`），
  拒绝路径穿越、超大包、压缩炸弹和超量文件。
- Skill 支持多版本、搜索、分类、标签、下载计数；作者可编辑 / 发新版 / 删除，管理员可隐藏 / 恢复 / 删除。
- 包体落在 `${DATA_DIR}/skills`，元数据新增 `skills` / `skill_versions` / `skill_downloads` 三张表（schema v6）。
- 新增 `FEISHU_WEB_REDIRECT_URI`、`SKILL_MAX_BYTES`、`SKILL_MAX_EXTRACTED_BYTES`、`SKILL_MAX_FILES` 配置。

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
