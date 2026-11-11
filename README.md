# staff-agent-platform

公司内部的**个人 Agent 平台**：员工把自己电脑上的 `pi` / Claude Code / Codex 接到平台，用飞书下指令，平台统一看所有 Agent 的 trace。

私有化单租户部署（每家公司一套），数据不出公司；飞书走**长连接**，内网不需要公网回调地址。

```
飞书（公司自建应用 · 事件订阅走长连接）
  │  私聊机器人 / 群里 @机器人 @某人
  ▼
platform（Node + Fastify + SQLite + React 后台）
  │  ├─ 绑定：open_id ↔ agent_id ↔ 设备令牌（一对一）
  │  ├─ 投递：长轮询 + 租约 + ack（不丢、不重、掉线可回收）
  │  └─ trace：任务级 + 步骤级 + 聚合统计
  ▲  POST /api/bridge/poll（长轮询，携带忙闲状态）
  │  POST /api/bridge/runs/:id/{ack,steps,report}
  │
staff-agent（员工电脑上的 npm 包）
  └─ runtime adapter：pi --mode rpc / claude stream-json / codex exec --json
```

## 为什么不用 agents-bridge

`agents-bridge` 是本地 CLI 网关，但它把运行时限定在 7 个内置后端（无 pi、不接受自定义命令）、没有自助注册、没有任何 trace 埋点，且绑定的是另一套 bot 数据模型。本项目复用了它的**协议形状**（长轮询 / ack / 状态上报），代码全部重写。

## 快速开始（Docker）

```bash
git clone <repo> && cd staff-agent-platform
cp .env.example .env
# 必改：ADMIN_PASSWORD；必填：FEISHU_APP_ID / FEISHU_APP_SECRET
vim .env

docker compose up -d --build
curl http://127.0.0.1:8787/api/health
```

打开 `http://127.0.0.1:8787` 进入管理后台（口令 = `ADMIN_PASSWORD`）。

本地开发：

```bash
pnpm install
pnpm --filter @staff-agent/web build          # 后台静态资源
FEISHU_ENABLED=false ADMIN_PASSWORD=dev-password DATA_DIR=./data \
  pnpm --filter @staff-agent/platform dev     # 平台 :8787
pnpm --filter @staff-agent/web dev            # 后台 :5173（/api 代理到 8787）
```

## 飞书应用配置

在[飞书开放平台](https://open.feishu.cn/app)创建**企业自建应用**：

| 项 | 配置 |
|---|---|
| 机器人能力 | 开启 |
| 权限 | `im:message`（接收消息）、`im:message:send_as_bot`（发消息）、`contact:user.base:readonly`（可选，用于显示姓名） |
| 事件订阅 | 模式选**长连接**，订阅 `im.message.receive_v1` |
| 发布 | 创建版本并发布，可用范围选需要使用的员工 |
| 群聊 | 把机器人拉进目标群 |

扫码绑定（可选，需要手机能访问平台地址）：

| 项 | 配置 |
|---|---|
| 网页应用能力 | 开启 |
| 安全设置 → 重定向 URL | `https://<你的域名>/bind/callback` |
| 环境变量 | `PUBLIC_BASE_URL=https://<你的域名>`、`FEISHU_OAUTH_REDIRECT_URI=https://<你的域名>/bind/callback` |

不配这两项时，二维码页面只展示绑定码，员工把码发到飞书即可，功能不受影响。

## 员工侧：接入自己的 Agent

```bash
# 1. 安装（Node >= 22.5）
npm install -g @staff-agent/bridge

# 2. 登录：选择本机已有的运行时
staff-agent login --platform http://<平台地址>:8787 --runtime pi --cwd ~/work

#    终端会显示 6 位绑定码；在飞书里把码发给机器人（或手机扫码）
#    绑定成功后凭据写入 ~/.staff-agent/config.json（0600）

# 3. 后台常驻
staff-agent start --daemon

# 其他
staff-agent status     # 登录状态、运行时版本、进程
staff-agent doctor     # 检查 pi / claude / codex 与平台连通性
staff-agent logs       # 查看日志文件路径（~/.staff-agent/logs/bridge.log）
staff-agent stop
```

三种运行时的事件能力：

| 运行时 | 驱动方式 | trace 完整度 |
|---|---|---|
| `pi` | `pi --mode rpc`（长驻 JSONL） | 最完整：工具入参/出参、耗时、token、settled |
| `claude` | `claude -p --output-format stream-json` | 工具调用、文本、token（`result.usage`） |
| `codex` | `codex exec --json` | 命令执行、文件变更、MCP 调用、token |

模型凭证始终在员工本机（各 CLI 自己的登录态），平台不代理模型调用、不保存模型 Key。

## 在飞书里怎么用

| 场景 | 用法 |
|---|---|
| 私聊机器人 | 直接发指令，执行者是机器人主人自己 |
| 群聊 | `@机器人 @张三 帮我看下这个报错`，任务投给**张三**的 Agent |
| 只 @机器人 不 @人 | 平台回复提示，要求补充执行人（不猜默认值） |
| 目标人没绑 Agent | 平台回复提示对方先运行 `staff-agent login` |
| 目标设备离线 | 任务照常入队，回复里说明「联网后自动执行」 |
| Agent 正在执行 | 任务排队，回复里说明前面还有几个 |

## 绑定与一对一约束

- **一个飞书人只能有一个 Agent**，一个 Agent 同时只有一台机器在线（换机时新设备顶掉旧设备）。
- 绑定码 6 位、5 分钟有效、一次性；数据库只存 HMAC，泄露库也反推不出码。
- 设备令牌只在绑定完成时下发一次，数据库只存 SHA-256；撤销后立即失效。
- 员工换电脑：重新 `login`（新设备自动顶掉旧设备）；换人使用同一台机器：管理员先「强制下线」，再让对方登录。

## trace

两级：

| 级别 | 内容 | 用途 |
|---|---|---|
| 任务级 `runs` | 谁在哪个会话发起、prompt、状态、耗时、token、最终结果、错误 | 管理员看统计与追责 |
| 步骤级 `steps` | `llm` / `tool` / `message` / `thinking` / `error`，含工具名、入参出参摘要、耗时、token、是否报错 | 排查「它到底做了什么」 |

- 入参出参先**脱敏再落库**：`sk-*`、`LTAI*`、`AKIA*`、Bearer、`password/token/secret=`、连接串密码、私钥块统一替换为 `***`。
- 明细保留 `TRACE_RETENTION_DAYS` 天（默认 7），过期只删步骤明细，任务级记录与聚合统计保留。
- 步骤以 `(run_id, seq)` 唯一约束幂等，网关重传不会产生重复。

## 协议（网关 ↔ 平台）

全部由网关主动外连；平台不访问员工机器。

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| POST | `/api/bridge/register` | 无 | 登记设备，返回 6 位绑定码 |
| POST | `/api/bridge/enroll/poll` | 无 | 轮询绑定结果，成功后一次性下发设备令牌 |
| POST | `/api/bridge/poll` | Bearer | 长轮询接任务（默认挂起 25s），同时上报忙闲状态 |
| POST | `/api/bridge/runs/:id/ack` | Bearer | 认领确认，刷新租约 |
| POST | `/api/bridge/runs/:id/steps` | Bearer | 批量上报步骤（幂等） |
| POST | `/api/bridge/runs/:id/report` | Bearer | 上报终态、结果、用量、运行时 session |
| GET | `/api/health` | 无 | 健康检查 |

**没有独立心跳接口**：长轮询本身就是心跳。`poll` 请求体携带 `state`（idle/busy）与 `activeRuns`，平台据此判断在线与忙闲，少一条链路就少一处状态不一致。

## 数据模型（SQLite，单文件）

| 表 | 说明 |
|---|---|
| `agents` | 飞书 open_id ↔ Agent（`feishu_open_id` 唯一，一对一约束落在这里） |
| `devices` | 设备、机器指纹、令牌哈希、最近心跳、忙闲状态 |
| `enroll_codes` | 绑定码哈希、过期时间、一次性 token 中转列 |
| `conversations` | Agent + 飞书会话 + thread → 运行时 sessionRef（多轮续聊） |
| `runs` | 任务级记录、租约、用量、最终结果 |
| `steps` | 步骤级 trace，`(run_id, seq)` 唯一 |
| `audit_logs` | 管理员操作审计 |

单文件部署的好处：备份 = 复制文件；迁移 = 启动时自动执行；500 个 Agent 的写压力（心跳 ≈ 20 次/秒）远低于 SQLite 单写者上限。

## 配置

所有配置走环境变量，仓库里没有任何凭证。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | SQLite 与日志目录（容器内 `/data`） |
| `ADMIN_PASSWORD` | 必填 | 管理后台口令（≥ 8 位） |
| `ADMIN_SESSION_SECRET` | 派生 | 会话与绑定码签名密钥 |
| `PUBLIC_BASE_URL` | 空 | 配置后绑定流程提供二维码 |
| `FEISHU_ENABLED` | `true` | 关闭后平台仍可启动（本地联调） |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 必填 | 飞书自建应用凭证 |
| `FEISHU_OPEN_BASE` | `https://open.feishu.cn` | Lark 国际版改成 `open.larksuite.com` |
| `FEISHU_OAUTH_REDIRECT_URI` | 空 | 扫码一步绑定所需回调 |
| `AGENT_TIMEOUT_SEC` | `1800` | 单次任务超时 |
| `POLL_HOLD_MS` | `25000` | 长轮询挂起时长，需小于反向代理空闲超时 |
| `RUN_LEASE_MS` | `120000` | 任务租约，超时回收重投 |
| `RUN_MAX_ATTEMPTS` | `3` | 最大重投次数 |
| `ONLINE_WINDOW_SEC` | `60` | 在线判定窗口 |
| `ENROLL_TTL_SEC` | `300` | 绑定码有效期 |
| `TRACE_RETENTION_DAYS` | `7` | 步骤明细保留天数 |
| `TRACE_MAX_SUMMARY_CHARS` | `2000` | 单条 trace 摘要上限 |
| `LOG_LEVEL` | `info` | `info` / `warn` / `error` |

网关侧可用 `STAFF_AGENT_HOME`（数据目录）、`STAFF_AGENT_PI_BIN` / `STAFF_AGENT_CLAUDE_BIN` / `STAFF_AGENT_CODEX_BIN`（可执行文件路径）、`STAFF_AGENT_*_ARGS`（追加启动参数）覆盖默认行为。

## 运维

```bash
# 日志
docker logs -f staff-agent-platform

# 备份（WAL 模式，推荐用 SQLite 在线备份，保证一致性）
docker compose exec platform node -e "
const {DatabaseSync}=require('node:sqlite');
new DatabaseSync('/data/staff-agent.db').exec(\"VACUUM INTO '/data/backup.db'\")"

# 升级
git pull && docker compose up -d --build

# 迁移（启动时自动执行，也可单独跑）
docker compose exec platform pnpm --filter @staff-agent/platform migrate
```

排障顺序：

1. `GET /api/health` 看平台与飞书连接状态；
2. 管理后台看 Agent 是否在线（最近心跳 < 60s）；
3. 员工机器跑 `staff-agent doctor`；
4. 看 `~/.staff-agent/logs/bridge.log` 与平台 `docker logs`；
5. 任务卡住看 `runs.lease_expires_at`：租约过期会自动回到队列。

## 目录结构

```
staff-agent-platform/
├── apps/
│   ├── platform/            # 平台服务
│   │   └── src/
│   │       ├── db/          # SQLite 连接与迁移
│   │       ├── domain/      # agents / devices / runs / steps / enroll
│   │       ├── feishu/      # 长连接客户端、网页授权
│   │       ├── http/        # bridge / admin / bind 路由
│   │       ├── services/    # 绑定、派发、投递箱、结果通知
│   │       └── trace/       # 脱敏、统计
│   └── web/                 # 管理后台（React + Vite）
├── packages/
│   ├── shared/              # 协议类型与 zod schema（前后端、网关共用）
│   └── bridge/              # 员工侧 npm 包（CLI + 3 个 runtime adapter）
├── docker-compose.yml
├── Dockerfile
└── .env.example
```

## 已知限制

- 飞书长连接同一应用只能有一个实例在线，多实例需要改成 HTTP 事件订阅。
- 只处理文本消息；图片、文件、语音暂不转发给 Agent。
- 群聊必须 `@机器人 + @人`；不做「按历史上次执行人」的隐式路由。
- 同一 Agent 串行执行任务；多个任务按到达顺序排队。
- 平台不代理模型调用，模型额度与凭证由员工本机 CLI 管理。
