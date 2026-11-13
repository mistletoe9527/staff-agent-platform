<div align="center">

# staff-agent-platform

**把每位员工自己电脑上的 `pi` / Claude Code / Codex 变成可管理的数字员工。**
飞书下发任务，本机执行，全链路 trace 集中观测。

[English](README.md) | [**简体中文**](README.zh-CN.md)

<sub>Node ≥ 24 · Fastify · SQLite · React · 单租户 · 私有化部署</sub>

</div>

---

## 目录

- [概览](#概览)
- [为什么不用 agents-bridge](#为什么不用-agents-bridge)
- [快速开始（Docker）](#快速开始docker)
- [飞书应用配置](#飞书应用配置)
- [员工侧：接入自己的 Agent](#员工侧接入自己的-agent)
- [在飞书里怎么用](#在飞书里怎么用)
- [Skill 广场](#skill-广场)
- [绑定、多工作区与一对一约束](#绑定多工作区与一对一约束)
- [trace](#trace)
- [协议（网关 ↔ 平台）](#协议网关--平台)
- [数据模型（SQLite，单文件）](#数据模型sqlite单文件)
- [配置](#配置)
- [运维](#运维)
- [目录结构](#目录结构)
- [已知限制](#已知限制)

## 概览

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
  ▲  POST /api/bridge/poll（长轮询，携带忙闲状态 + 主工作区目录）
  │  POST /api/bridge/runs/:id/{ack,steps,report}（report 回传实际执行目录）
  │
sa（员工电脑上的 npm 包，旧名 staff-agent）
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

> 本地开发前先停掉 docker 里的同名服务，否则 8787 被占用会报 `EADDRINUSE`：
> `docker compose stop platform`（要恢复容器就 `docker compose start platform`）。
> 换端口启动时需要同时改 `apps/web/vite.config.ts` 的代理目标，例如 `PORT=8788 pnpm ... dev` + 代理指向 `:8788`。

## 飞书应用配置

在[飞书开放平台](https://open.feishu.cn/app)创建**企业自建应用**：

| 项 | 配置 |
|---|---|
| 机器人能力 | 开启 |
| 权限 | `im:message`（接收消息）、`im:message:send_as_bot`（发消息）、`contact:contact.base:readonly`（可选，用于显示姓名） |
| 事件订阅 | 模式选**长连接**，订阅 `im.message.receive_v1` |
| 发布 | 创建版本并发布，可用范围选需要使用的员工 |
| 群聊 | 把机器人拉进目标群 |

扫码绑定（可选，需要手机能访问平台地址）：

| 项 | 配置 |
|---|---|
| 通讯录权限（推荐） | `contact:contact.base:readonly` — 绑定时同步飞书**姓名 + 头像**，后台能认出是谁的数字员工；不开也能用，只是显示 `agent-xxxx` 和首字母占位头像 |
| 网页应用能力 | 开启 |
| 安全设置 → 重定向 URL | `https://<你的域名>/bind/callback` |
| 环境变量 | `PUBLIC_BASE_URL=https://<你的域名>`、`FEISHU_OAUTH_REDIRECT_URI=https://<你的域名>/bind/callback` |
| Skill 广场员工登录（可选） | 网页应用能力；安全设置 → 重定向 URL 增加 `https://<你的域名>/api/auth/feishu/callback` |

不配这两项时，二维码页面只展示绑定码，员工把码发到飞书即可，功能不受影响。

已绑定的人补开通讯录权限后，不用重登：管理后台 Agent 列表点「同步身份」即可拉取姓名与头像
（`POST /api/admin/agents/:id/sync-profile`）。

> 平台服务端用 `tenant_access_token`（应用身份）调通讯录，所以要开的是 `contact:contact.base:readonly`，
> 不是同名易混的 `contact:user.base:readonly`（那是用户身份权限，开了也拿不到数据）。

### 排查：同步身份失败

「同步身份」失败时，后台提示里会带飞书原始错误码，对照处理：

| 飞书返回 | 原因 | 处理 |
|---|---|---|
| `99991672` 权限不足 | 没开通 `contact:contact.base:readonly`，或开了没发布版本 | 开放平台「权限管理」添加该权限（应用身份）→ 创建版本并发布 → 企业管理员审核通过 |
| `41050` no user authority | 权限有了，但该员工不在应用的通讯录**数据权限**范围内 | 开放平台「权限管理 → 数据权限」把可见范围设为全员或包含该员工，再发布版本 |
| `99991663` token 无效 | 凭证与域名不匹配，或改了凭证没重启 | 检查 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_OPEN_BASE`（国内 `open.feishu.cn`，国际 `open.larksuite.com`），重启服务 |

改完权限记得**发布版本并等审核通过**：只勾权限不发版，`tenant_access_token` 拿到的 scope 不会更新。

### 排查：飞书里发了绑定码没反应

平台日志里搜 `收到飞书消息`：

- **搜得到**：说明飞书事件已经到了平台，问题在绑定码本身（位数、是否过期、是否已被用掉），看紧邻的 `收到绑定码消息` 与绑定失败日志。
- **搜不到**（终端一直停在 `等待绑定中…`）则是飞书后台配置没生效，按顺序核对：
  1. 事件与回调 → 订阅方式 = **使用长连接接收事件**（配了 Webhook 地址时事件会走 Webhook，长连接收不到）。
  2. 已订阅事件 `im.message.receive_v1`（接收消息）。
  3. 权限已开通：`im:message`、`im:message.p2p_msg:readonly`（单聊）、`im:message.group_at_msg:readonly`（群里 @机器人）、`im:message:send_as_bot`。
  4. **改完配置必须创建版本并发布**，且机器人可用范围包含你自己。
  5. 同一个应用凭证不要在多处跑（长连接多实例会抢事件），本机先 `docker compose ps` 确认只有一份。

平台侧自检：`curl -s localhost:8787/api/health` 里的 `feishu` 必须是 `connected`。

## 员工侧：接入自己的 Agent

> `@staff-agent/bridge` 是仓库内的私有 workspace 包，**没有发布到 npm 公共源**，
> `npm install -g @staff-agent/bridge` 会直接 404。请按下面两种方式之一安装（Node >= 22.5）。

**A. 本仓库开发机自用（推荐）**

```bash
pnpm install
pnpm bridge:link        # = build + npm install -g ./packages/bridge
```

`npm install -g ./packages/bridge` 会做软链，源码目录重建后（`pnpm bridge:build`）全局命令自动生效，无需重装。

命令简写为 **`sa`**，旧名 `staff-agent` 作为别名保留（两套都指向同一个入口，老脚本不用改）。

> ⚠️ macOS 自带 `/usr/sbin/sa`（系统记账工具），而默认 PATH 里 `/usr/sbin` 排在 `/opt/homebrew/bin` 前面，
> 所以直接敲 `sa login` 会变成 `sa: open login read-only: No such file or directory`。三种解法（选一）：
>
> 1. 交互式用别名（推荐，只影响自己的 shell）：
>    ```bash
>    echo "alias sa='staff-agent'" >> ~/.zshrc && exec zsh
>    ```
> 2. 全局搞定：`sudo ln -sf "$(which staff-agent)" /usr/local/bin/sa`
>    （`/usr/local/bin` 在 PATH 里排第一，一次就永久生效，脚本里也能用）
> 3. 不改环境：直接用长名 `staff-agent login ...`（两个名字指向同一入口）

**B. 打包给同事安装（tgz 分发）**

```bash
pnpm bridge:pack                      # 产物：.pack/staff-agent-bridge-<version>.tgz
# 把 tgz 发给同事，对方执行：
npm install -g ./staff-agent-bridge-<version>.tgz
```

> 需要像公共包一样 `npm i -g @staff-agent/bridge` 分发时，得发布到私有 registry
> （Verdaccio / npmjs 私有 scope / GitHub Packages），并把 `private` 改为 `false`、补上 `publishConfig`。

```bash
# 1. 登录：选择本机已有的运行时
sa login --platform http://<平台地址>:8787 --runtime pi

#    终端会显示 6 位绑定码；在飞书里把码发给机器人（或手机扫码）
#    绑定成功后自动生成主工作区 ~/staff-agent-workspaces/<Agent 名>（可用 --cwd 指定，
#    或用 STAFF_AGENT_WORKSPACES 换根目录），凭据写入 ~/.staff-agent/config.json（0600）

# 2. 后台常驻
sa start --daemon

# 3. 可选：新增工作区（= 一个工作目录 + 职责边界），只存本机配置，平台看不到
sa agents add --name 前端 --cwd ~/work/web
#    不写 --description 时，本机运行时会先读一遍目录，自动总结这个工作区负责什么
sa agents list        # 主工作区 + 自定义工作区、目录、职责
sa agents update 前端 --ai-description   # 目录变了，重新生成职责说明
sa agents remove 前端                    # 删除工作区（只删本机配置，工作目录保留）

# 其他
sa status     # 登录状态、运行时版本、进程
sa doctor     # 检查 pi / claude / codex 与平台连通性
sa logs       # 查看日志文件路径（~/.staff-agent/logs/bridge.log）
sa stop
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
| 私聊机器人 | 直接发指令，执行者是机器人主人自己的主 Agent |
| 群聊 | `@机器人 @张三 帮我看下这个报错`，任务投给**张三**的 Agent |
| 只 @机器人 不 @人 | 平台回复提示，要求补充执行人（不猜默认值） |
| 目标人没绑 Agent | 平台回复提示对方先运行 `sa login` |
| 目标设备离线 | 任务照常入队，回复里说明「联网后自动执行」 |
| Agent 正在执行 | 任务排队，回复里说明前面还有几个 |
| 有工作区 | 执行者仍是主 Agent：网关把本机工作区的职责边界与目录写进提示词，由它判断进哪个目录干活 |
| 任务里提到工作区名 | 名字命中（例：工作区「健康管理+商城」+ 问题「健康管理有哪些功能」）时，提示词会直接指明去那个目录，不靠模型猜 |
| 指定工作区 | `#前端 帮我把登录页改成新设计`，直接在该工作区目录执行（`#名字` 由本机解析） |
| 查看工作区 | `#列表` 由本机直接回复（不花模型 token），列出主工作区 + 工作区、目录与职责 |

## Skill 广场

后台内置一个轻量的员工 Skill 市场：同事把可复用的 Agent 技能包上传到平台，其他人登录后直接下载。

- **两种登录方式**：员工用飞书网页授权登录，只看到 Skill 广场；管理员用 `ADMIN_PASSWORD` 登录，
  可访问全部后台并管理所有 Skill。未配置飞书网页授权时，管理员仍可正常上传 / 管理。
- **上传格式**：支持 zip、单个 `SKILL.md`，或直接选择 Skill 文件夹（浏览器里打包）。
  服务端会剥掉唯一的顶层目录，保证下载包的根目录就是 `SKILL.md`。
- **安全校验**：拒绝绝对路径 / `..` 路径穿越、缺少 `SKILL.md`、超大包、压缩炸弹和超量文件；
  包体大小与解压体积分别由 `SKILL_MAX_BYTES` / `SKILL_MAX_EXTRACTED_BYTES` 控制。
- **版本**：首次上传创建 Skill，后续上传新版本；历史版本保留并可单独下载，下载默认取最新版。
- **权限**：作者可编辑信息、上传新版本、删除自己的 Skill；管理员可隐藏 / 恢复 / 删除任意 Skill。
  隐藏后的 Skill 只有作者和管理员可见。
- **存储**：元数据在 SQLite（`skills` / `skill_versions` / `skill_downloads`），
  包体在 `${DATA_DIR}/skills/<skill-id>/<version-id>.zip`，备份数据目录时一起备份。

飞书员工登录需要在飞书开放平台「安全设置 - 重定向 URL」中增加
`https://<你的域名>/api/auth/feishu/callback`（或通过 `FEISHU_WEB_REDIRECT_URI` 指定），
并确保应用已开启网页能力。配置后登录页会出现「使用飞书登录」。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/me` | 当前登录身份与是否启用飞书登录 |
| GET | `/api/auth/feishu/start` | 跳转飞书网页授权 |
| GET | `/api/auth/feishu/callback` | 飞书回调，设置员工会话 |
| GET | `/api/skills` | 列表 / 搜索 / 分类 / 分页 |
| POST | `/api/skills?name=&version=&...` | 上传首版（raw zip / markdown body） |
| GET | `/api/skills/:id` | 详情与版本历史 |
| POST | `/api/skills/:id/versions` | 上传新版本 |
| PATCH | `/api/skills/:id` | 编辑元数据；管理员可改状态 |
| DELETE | `/api/skills/:id?confirm=<名称>` | 删除 Skill |
| GET | `/api/skills/:id/download?version=` | 下载指定版本（默认最新） |

## 绑定、多工作区与一对一约束

- **一个飞书人一个主 Agent**，主 Agent 同时只有一台机器在线（换机时新设备顶掉旧设备）。
- 工作区（以前的「子 Agent」）**只存在本机** `~/.staff-agent/config.json`，平台完全不知道有哪些：
  目录是本机路径，放到平台上只会变成一份会过期的副本。多轮对话共用主 Agent 会话，上下文不因切换目录而断。
- 平台只下发飞书原文；`#名字` / `#列表` 的解析、目录选择、提示词里的工作区清单都由网关在本地完成，
  任务结束后网关把**实际执行目录**随结果回传，后台在任务详情里能看到。
- 工作区描述留空时，客户端会让本机运行时真的去读目录，自动总结一句职责说明。
- **增删改工作区立即生效**：网关按 `config.json` 的 mtime 自动重载，不用 `sa stop && start`
  （以前网关只在启动时读一次配置，新加的工作区会让任务落到空的主工作区）。
- **删除工作区**：`sa agents remove <名称>`，只删本机配置，机器上的目录原样保留。
- **不向会话暴露本机信息**：提示词里明确要求只回结论，不提路径、家目录、工作区名称，也不描述「切目录/搜索/读了什么」；
  目录里没材料时直接给通用答案，而不是说「工作区是空的」。`#列表` 是例外（会列出本机目录，建议只在私聊里用）。
- **后台只有一个 Agent**：管理后台的 Agent 列表、Agent 总数、运行时分布都只按主 Agent 统计（`is_primary = 1`）。
- 三个管理动作的区别：**禁用**（保留身份与设备，随时可恢复）/ **强制下线**（只撤销令牌，身份还在）/
  **删除**（把这个人从平台移除，设备归属一起清空）。
- **删除数字员工**：后台 Agent 列表「删除」（要求输入 Agent 名确认），或
  `DELETE /api/admin/agents/:id?confirm=<Agent 名>`。会撤销设备令牌、清空会话与未用绑定码，
  历史任务与 trace 保留（任务列表里显示「已删除的 Agent」）；那台机器重新 `sa login` 就能再绑。
- 换电脑要重新 `sa agents add`（工作区是本机配置）；`login` 不会清空已有的工作区列表。
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
| POST | `/api/bridge/poll` | Bearer | 长轮询接任务（默认挂起 25s），同时上报忙闲状态 + 主工作区目录/职责 |
| POST | `/api/bridge/runs/:id/ack` | Bearer | 认领确认，刷新租约 |
| POST | `/api/bridge/runs/:id/steps` | Bearer | 批量上报步骤（幂等） |
| POST | `/api/bridge/runs/:id/report` | Bearer | 上报终态、结果、用量、运行时 session、实际执行目录 `cwd` |
| GET | `/api/health` | 无 | 健康检查 |

**没有独立心跳接口**：长轮询本身就是心跳。`poll` 请求体携带 `state`（idle/busy）与 `activeRuns`，平台据此判断在线与忙闲，少一条链路就少一处状态不一致。

## 数据模型（SQLite，单文件）

| 表 | 说明 |
|---|---|
| `agents` | 飞书人 ↔ Agent：平台只存主 Agent（`is_primary = 1`），`cwd`/`description` 由网关心跳上报；工作区在员工本机 |
| `devices` | 设备、机器指纹、令牌哈希、最近心跳、忙闲状态 |
| `enroll_codes` | 绑定码哈希、过期时间、一次性 token 中转列 |
| `conversations` | Agent + 飞书会话 + thread → 运行时 sessionRef（多轮续聊） |
| `runs` | 任务级记录、租约、用量、最终结果 |
| `steps` | 步骤级 trace，`(run_id, seq)` 唯一 |
| `skills` | Skill 聚合根：名称、简介、分类、标签、作者、状态、累计下载量 |
| `skill_versions` | 每个版本一个 zip 包：版本号、大小、SHA-256、文件清单、SKILL.md 预览、下载量 |
| `skill_downloads` | Skill 下载明细，用于审计与统计 |
| `audit_logs` | 管理员与员工关键操作审计 |

单文件部署的好处：备份 = 复制文件；迁移 = 启动时自动执行；500 个 Agent 的写压力（心跳 ≈ 20 次/秒）远低于 SQLite 单写者上限。

## 配置

所有配置走环境变量，仓库里没有任何凭证。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | SQLite、日志与 Skill 包目录（容器内 `/data`） |
| `ADMIN_PASSWORD` | 必填 | 管理后台口令（≥ 8 位） |
| `ADMIN_SESSION_SECRET` | 派生 | 会话与绑定码签名密钥 |
| `PUBLIC_BASE_URL` | 空 | 配置后绑定流程提供二维码 |
| `FEISHU_ENABLED` | `true` | 关闭后平台仍可启动（本地联调） |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 必填 | 飞书自建应用凭证 |
| `FEISHU_OPEN_BASE` | `https://open.feishu.cn` | Lark 国际版改成 `open.larksuite.com` |
| `FEISHU_OAUTH_REDIRECT_URI` | 空 | 扫码一步绑定所需回调 |
| `FEISHU_WEB_REDIRECT_URI` | 派生 | 员工飞书登录回调；不配则用 `${PUBLIC_BASE_URL}/api/auth/feishu/callback` |
| `AGENT_TIMEOUT_SEC` | `1800` | 单次任务超时 |
| `POLL_HOLD_MS` | `25000` | 长轮询挂起时长，需小于反向代理空闲超时 |
| `RUN_LEASE_MS` | `120000` | 任务租约，超时回收重投 |
| `RUN_MAX_ATTEMPTS` | `3` | 最大重投次数 |
| `ONLINE_WINDOW_SEC` | `60` | 在线判定窗口 |
| `ENROLL_TTL_SEC` | `300` | 绑定码有效期 |
| `TRACE_RETENTION_DAYS` | `7` | 步骤明细保留天数 |
| `TRACE_MAX_SUMMARY_CHARS` | `2000` | 单条 trace 摘要上限 |
| `SKILL_MAX_BYTES` | `20971520` | Skill 包最大压缩体积（20MB） |
| `SKILL_MAX_EXTRACTED_BYTES` | `83886080` | Skill 包解压后最大总体积（80MB） |
| `SKILL_MAX_FILES` | `800` | Skill 包内最大文件数 |
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
3. 员工机器跑 `sa doctor`；
4. 看 `~/.staff-agent/logs/bridge.log` 与平台 `docker logs`；
5. 任务卡住看 `runs.lease_expires_at`：租约过期会自动回到队列。
6. 任务直接失败且报 `spawn xxx ENOENT`：要么运行时 CLI 不在 PATH（后台进程常由 launchd 拉起，PATH 很精简，网关会额外搜索 `~/.pi/agent/bin`、`~/.local/bin`、`/opt/homebrew/bin` 等目录），要么配置里的任务工作目录不存在（网关会按 `mkdir -p` 自动补建，补建失败才会失败任务）。
7. Windows 上 `sa doctor` 报 `spawn pi/claude/codex ENOENT`：先确认 `where codex` 能查到（Git Bash 里 `which` 只对 bash 生效），再确认 `sa` 是在**安装完 CLI 之后**启动的——`sa start` 的守护进程会继承启动那一刻的 PATH，装完 CLI 要 `sa stop && sa start`。npm 全局安装会把 CLI 放在 `%APPDATA%\npm`（即 `C:\Users\<你>\AppData\Roaming\npm`），网关会自动兜底搜这个目录；如果 CLI 装在别处，用 `STAFF_AGENT_CODEX_BIN` 这类环境变量指向绝对路径（必须是 `.exe` 或 `.cmd`）。

## 目录结构

```
staff-agent-platform/
├── apps/
│   ├── platform/            # 平台服务
│   │   └── src/
│   │       ├── db/          # SQLite 连接与迁移
│   │       ├── domain/      # agents / devices / runs / steps / enroll / skills
│   │       ├── feishu/      # 长连接客户端、网页授权
│   │       ├── http/        # bridge / admin / auth / skills / bind 路由
│   │       ├── services/    # 绑定、派发、投递箱、结果通知、Skill 存储、网页会话
│   │       └── trace/       # 脱敏、统计
│   └── web/                 # 管理后台 + Skill 广场（React + Vite）
├── packages/
│   ├── shared/              # 协议类型与 zod schema（前后端、网关共用）
│   └── bridge/              # 员工侧 npm 包（CLI + 3 个 runtime adapter）
│       └── src/
│           ├── routing.ts   # 本机工作区路由：#名字 / #列表 / 提示词组装
│           ├── agents.ts    # 工作区 CRUD（只写本机 config.json）
│           └── runner.ts    # 任务执行 + trace 上报（含实际执行目录）
├── docker-compose.yml
├── Dockerfile
└── .env.example
```

## 已知限制

- 飞书长连接同一应用只能有一个实例在线，多实例需要改成 HTTP 事件订阅。
- 只处理文本消息；图片、文件、语音暂不转发给 Agent。
- 群聊必须 `@机器人 + @人`；不做「按历史上次执行人」的隐式路由。
- 同一 Agent 串行执行任务；多个任务按到达顺序排队（工作区只是目录，不与主 Agent 并行）。
- 平台不代理模型调用，模型额度与凭证由员工本机 CLI 管理。
- Skill 广场按登录身份共享，不做审批流与敏感信息扫描；上传前请自行确认包内没有密钥、凭证或内部敏感数据。

---

<div align="center">
<sub>版本变更见 <a href="CHANGELOG.md">CHANGELOG.md</a> · 有问题请提 issue。</sub>
</div>
