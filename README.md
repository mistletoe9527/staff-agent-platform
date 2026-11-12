<div align="center">

# staff-agent-platform

**Turn every employee's own `pi` / Claude Code / Codex into a manageable digital employee.**
Tasks come in from Feishu, run locally on the employee's machine, and every step is traced in one place.

[**English**](README.md) | [简体中文](README.zh-CN.md)

<sub>Node ≥ 24 · Fastify · SQLite · React · single-tenant · self-hosted</sub>

</div>

---

## Contents

- [Overview](#overview)
- [Why not agents-bridge](#why-not-agents-bridge)
- [Quick start (Docker)](#quick-start-docker)
- [Feishu app setup](#feishu-app-setup)
- [Employee side: connect your own agent](#employee-side-connect-your-own-agent)
- [Using it in Feishu](#using-it-in-feishu)
- [Skill marketplace](#skill-marketplace)
- [Binding, workspaces, and one-to-one constraints](#binding-workspaces-and-one-to-one-constraints)
- [Tracing](#tracing)
- [Protocol (bridge ↔ platform)](#protocol-bridge--platform)
- [Data model (SQLite, single file)](#data-model-sqlite-single-file)
- [Configuration](#configuration)
- [Operations](#operations)
- [Repository layout](#repository-layout)
- [Known limitations](#known-limitations)

## Overview

A company-internal **personal agent platform**. Employees connect the agent runtime already installed
on their own laptop to the platform, dispatch work from Feishu, and administrators get a unified
trace view over every agent in the company.

Private, single-tenant deployment (one instance per company): data never leaves the company.
Feishu runs over a **persistent WebSocket connection**, so no public callback URL is required on an
intranet.

```
Feishu (company self-built app · events over WebSocket)
  │  direct message to the bot / @bot + @person in a group
  ▼
platform (Node + Fastify + SQLite + React admin console)
  │  ├─ binding:   open_id ↔ agent_id ↔ device token (one-to-one)
  │  ├─ delivery:  long polling + lease + ack (no loss, no duplicates, offline recovery)
  │  └─ trace:     run-level + step-level + aggregated stats
  ▲  POST /api/bridge/poll (long poll, carries idle/busy state + primary workspace dir)
  │  POST /api/bridge/runs/:id/{ack,steps,report} (report returns the actual cwd)
  │
sa (npm package on the employee machine, formerly staff-agent)
  └─ runtime adapters: pi --mode rpc / claude stream-json / codex exec --json
```

## Why not agents-bridge

`agents-bridge` is a local CLI gateway, but it hard-codes 7 built-in backends (no `pi`, no custom
commands), has no self-service registration, no trace instrumentation at all, and binds to a
different bot data model. This project reuses its **protocol shape** (long polling / ack / state
reporting) and reimplements everything else.

## Quick start (Docker)

```bash
git clone <repo> && cd staff-agent-platform
cp .env.example .env
# required: ADMIN_PASSWORD, FEISHU_APP_ID, FEISHU_APP_SECRET
vim .env

docker compose up -d --build
curl http://127.0.0.1:8787/api/health
```

Open `http://127.0.0.1:8787` for the admin console (password = `ADMIN_PASSWORD`).

Local development:

```bash
pnpm install
pnpm --filter @staff-agent/web build          # admin console static assets
FEISHU_ENABLED=false ADMIN_PASSWORD=dev-password DATA_DIR=./data \
  pnpm --filter @staff-agent/platform dev     # platform :8787
pnpm --filter @staff-agent/web dev            # admin console :5173 (/api proxied to 8787)
```

> Stop the Docker service before running locally, otherwise port 8787 is taken and you get
> `EADDRINUSE`: `docker compose stop platform` (restore with `docker compose start platform`).
> If you change the port, also update the proxy target in `apps/web/vite.config.ts`
> (e.g. `PORT=8788 pnpm ... dev` with the proxy pointing at `:8788`).

## Feishu app setup

Create a **company self-built app** on the [Feishu Open Platform](https://open.feishu.cn/app):

| Item | Setting |
|---|---|
| Bot capability | Enabled |
| Permissions | `im:message` (receive), `im:message:send_as_bot` (send), `contact:contact.base:readonly` (optional, for display names) |
| Event subscription | Mode = **WebSocket long connection**, subscribe `im.message.receive_v1` |
| Release | Create a version and publish; set availability to the employees who need it |
| Group chat | Add the bot to the target groups |

QR-code binding (optional; requires the phone to reach the platform URL):

| Item | Setting |
|---|---|
| Contact permission (recommended) | `contact:contact.base:readonly` — syncs Feishu **name + avatar** on binding, so the console shows who the digital employee is; without it you still get `agent-xxxx` with an initial-letter avatar |
| Web app capability | Enabled |
| Security → Redirect URL | `https://<your-domain>/bind/callback` |
| Environment | `PUBLIC_BASE_URL=https://<your-domain>`, `FEISHU_OAUTH_REDIRECT_URI=https://<your-domain>/bind/callback` |
| Skill marketplace employee login (optional) | Web app capability; add `https://<your-domain>/api/auth/feishu/callback` under Security → Redirect URL |

Without these two settings the QR page only shows the binding code — the employee sends it to the
bot in Feishu and everything still works.

Users already bound can enable the contact permission later without re-login: click
**Sync profile** in the console agent list (`POST /api/admin/agents/:id/sync-profile`).

> The server calls the directory with `tenant_access_token` (app identity), so the permission needed
> is `contact:contact.base:readonly` — not the similarly named `contact:user.base:readonly`
> (user identity, which returns nothing here).

### Troubleshooting: profile sync fails

Failures surface the original Feishu error code in the console:

| Feishu error | Cause | Fix |
|---|---|---|
| `99991672` permission denied | `contact:contact.base:readonly` not granted, or granted but no release published | Add the permission (app identity) → create and publish a version → tenant admin approves |
| `41050` no user authority | Permission granted, but the employee is outside the app's **data scope** | Set the visible range in *Permissions → Data scope* to all staff or to include that employee, then publish |
| `99991663` invalid token | Credentials do not match the domain, or changed without restart | Check `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_OPEN_BASE` (`open.feishu.cn` domestic, `open.larksuite.com` international), restart |

After changing permissions, **publish a version and wait for approval**: granting scopes without a
release does not update the scopes returned by `tenant_access_token`.

### Troubleshooting: binding code sent in Feishu does nothing

Search the platform logs for `收到飞书消息`:

- **Found**: events reach the platform; the problem is the code itself (length, expired, already
  used). Check the adjacent `收到绑定码消息` and binding-failure logs.
- **Not found** (the terminal stays on `等待绑定中…`): the Feishu console config is not in effect.
  Verify in this order:
  1. *Events & Callbacks* → subscription mode = **Receive events over long connection**
     (a configured Webhook makes events go there instead).
  2. `im.message.receive_v1` (receive message) is subscribed.
  3. Permissions granted: `im:message`, `im:message.p2p_msg:readonly` (direct messages),
     `im:message.group_at_msg:readonly` (group @bot), `im:message:send_as_bot`.
  4. **Create a version and publish** after any config change, and the bot's availability includes you.
  5. The same app credentials are not running in multiple places (multiple long-connection
     instances compete for events) — check `docker compose ps` locally.

Platform self-check: the `feishu` field in `curl -s localhost:8787/api/health` must be `connected`.

## Employee side: connect your own agent

> `@staff-agent/bridge` is a private workspace package in this repo and is **not published to the
> public npm registry** — `npm install -g @staff-agent/bridge` returns 404. Install it one of the two
> ways below (Node ≥ 22.5).

**A. From this repo (recommended for developers)**

```bash
pnpm install
pnpm bridge:link        # = build + npm install -g ./packages/bridge
```

`npm install -g ./packages/bridge` creates a symlink, so rebuilding the source
(`pnpm bridge:build`) updates the global command without reinstalling.

The command is shortened to **`sa`**, with `staff-agent` kept as an alias (both point at the same
entry, existing scripts keep working).

> ⚠️ macOS ships `/usr/sbin/sa` (the accounting tool), and `/usr/sbin` precedes `/opt/homebrew/bin`
> in the default PATH, so `sa login` fails with
> `sa: open login read-only: No such file or directory`. Pick one of three fixes:
>
> 1. Interactive alias (recommended, shell-local):
>    ```bash
>    echo "alias sa='staff-agent'" >> ~/.zshrc && exec zsh
>    ```
> 2. Global fix: `sudo ln -sf "$(which staff-agent)" /usr/local/bin/sa`
>    (`/usr/local/bin` comes first in PATH, works in scripts too)
> 3. Change nothing: use the long name `staff-agent login ...` (same entry point)

**B. Package for colleagues (tgz distribution)**

```bash
pnpm bridge:pack                      # output: .pack/staff-agent-bridge-<version>.tgz
# send the tgz to a colleague, who runs:
npm install -g ./staff-agent-bridge-<version>.tgz
```

> To distribute it like a public package (`npm i -g @staff-agent/bridge`), publish to a private
> registry (Verdaccio / private scope on npmjs / GitHub Packages), set `private` to `false` and add
> `publishConfig`.

```bash
# 1. Log in: pick a runtime already installed on this machine
sa login --platform http://<platform-host>:8787 --runtime pi

#    The terminal shows a 6-digit binding code; send it to the bot in Feishu (or scan the QR code).
#    On success the primary workspace ~/staff-agent-workspaces/<agent-name> is created
#    (override with --cwd, or move the root with STAFF_AGENT_WORKSPACES); credentials are written
#    to ~/.staff-agent/config.json (0600).

# 2. Run in the background
sa start --daemon

# 3. Optional: add workspaces (= a working directory + a scope of responsibility), local-only
sa agents add --name frontend --cwd ~/work/web
#    Without --description, the local runtime reads the directory first and summarizes what it owns
sa agents list        # primary workspace + custom workspaces, directories, responsibilities
sa agents update frontend --ai-description   # directory changed, regenerate the description
sa agents remove frontend                    # delete the workspace (local config only, files kept)

# Other commands
sa status     # login state, runtime version, process
sa doctor     # check pi / claude / codex and platform connectivity
sa logs       # path to the log file (~/.staff-agent/logs/bridge.log)
sa stop
```

Event fidelity per runtime:

| Runtime | Driver | Trace completeness |
|---|---|---|
| `pi` | `pi --mode rpc` (long-lived JSONL) | Best: tool inputs/outputs, durations, tokens, settled |
| `claude` | `claude -p --output-format stream-json` | Tool calls, text, tokens (`result.usage`) |
| `codex` | `codex exec --json` | Command execution, file changes, MCP calls, tokens |

Model credentials always stay on the employee's machine (each CLI keeps its own login). The platform
never proxies model calls and never stores model keys.

## Using it in Feishu

| Scenario | How |
|---|---|
| Direct message to the bot | Just send the instruction; executed by the bot owner's own primary agent |
| Group chat | `@bot @Alice please look at this error` — the task goes to **Alice's** agent |
| Only `@bot`, no person | The platform replies asking for the executor (it never guesses a default) |
| Target has no agent bound | The platform replies asking them to run `sa login` |
| Target device offline | The task is queued anyway; the reply says it will run once back online |
| Agent busy | The task is queued; the reply says how many are ahead |
| Workspaces exist | The executor is still the primary agent: the gateway injects the local workspaces' responsibilities and directories into the prompt and lets it choose where to work |
| Task mentions a workspace | On a name hit (e.g. workspace `health+mall` with the question "what features does health have"), the prompt names the directory instead of making the model guess |
| Explicit workspace | `#frontend convert the login page to the new design` — runs in that directory (`#name` resolved locally) |
| List workspaces | `#list` is answered locally (no model tokens), listing the primary + custom workspaces, directories and responsibilities |

## Skill marketplace

The console ships with a lightweight internal Skill marketplace: employees upload reusable agent
skill packages, and everyone else can download them after signing in.

- **Two identities**: employees sign in with Feishu web authorization and only see the marketplace;
  admins sign in with `ADMIN_PASSWORD` and can access the full console and moderate every Skill.
  Without Feishu web login configured, admins can still upload and manage Skills.
- **Upload formats**: a zip, a single `SKILL.md`, or a Skill folder selected in the browser (zipped
  locally). The server strips a single top-level directory so the downloaded package always has
  `SKILL.md` at its root.
- **Validation**: absolute paths and `..` traversal are rejected, `SKILL.md` is required, and
  compressed size, extracted size and file count are capped by `SKILL_MAX_BYTES`,
  `SKILL_MAX_EXTRACTED_BYTES` and `SKILL_MAX_FILES`.
- **Versions**: the first upload creates the Skill; later uploads append versions. Old versions
  remain downloadable, and downloads default to the latest.
- **Permissions**: authors can edit metadata, publish new versions and delete their own Skills;
  admins can hide / restore / delete any Skill. Hidden Skills are visible only to the author and
  admins.
- **Storage**: metadata lives in SQLite (`skills` / `skill_versions` / `skill_downloads`); packages
  live under `${DATA_DIR}/skills/<skill-id>/<version-id>.zip`, so backing up `DATA_DIR` includes them.

For employee Feishu login, add `https://<your-domain>/api/auth/feishu/callback` to the Feishu app's
**Security → Redirect URL** list (or set `FEISHU_WEB_REDIRECT_URI` explicitly) and enable the web
app capability. The login page then shows **Sign in with Feishu**.

| Method | Path | Description |
|---|---|---|
| GET | `/api/auth/me` | Current identity and whether Feishu login is enabled |
| GET | `/api/auth/feishu/start` | Redirect to Feishu web authorization |
| GET | `/api/auth/feishu/callback` | Feishu callback; sets the employee session |
| GET | `/api/skills` | List / search / categories / pagination |
| POST | `/api/skills?name=&version=&...` | Publish the first version (raw zip / markdown body) |
| GET | `/api/skills/:id` | Detail and version history |
| POST | `/api/skills/:id/versions` | Publish a new version |
| PATCH | `/api/skills/:id` | Edit metadata; admins may change status |
| DELETE | `/api/skills/:id?confirm=<name>` | Delete a Skill |
| GET | `/api/skills/:id/download?version=` | Download a version (latest by default) |

## Binding, workspaces, and one-to-one constraints

- **One Feishu person, one primary agent**, with exactly one machine online at a time (a new device
  displaces the old one on re-login).
- Workspaces (formerly "sub-agents") **exist only on the local machine** in
  `~/.staff-agent/config.json`; the platform has no idea which ones exist. Directories are local
  paths — uploading them would only produce a stale copy. Multi-turn conversations share the primary
  agent session, so context survives directory switches.
- The platform delivers only the raw Feishu text; `#name` / `#list` resolution, directory selection
  and the workspace list in the prompt are all done locally by the gateway. After a task the gateway
  reports the **actual working directory**, visible in the console's run detail.
- When a workspace has no description, the client asks the local runtime to actually read the
  directory and summarize its responsibility in one sentence.
- **Workspace changes take effect immediately**: the gateway reloads on `config.json` mtime, no
  `sa stop && start` needed (previously config was read once at startup, so a new workspace silently
  fell back to the primary workspace).
- **Removing a workspace**: `sa agents remove <name>` deletes local config only; the directory on
  disk is untouched.
- **No host details leak into the conversation**: the prompt requires conclusions only — no paths,
  home directory, workspace names, and no narration of "switching directories / searching / reading
  files". If the directory has no relevant material, answer generically rather than saying the
  workspace is empty. `#list` is the exception (it lists local directories — prefer direct messages).
- **The console shows exactly one agent per person**: agent list, agent count and runtime
  distribution count only primary agents (`is_primary = 1`).
- Three admin actions differ: **disable** (keeps identity and device, reversible) /
  **force offline** (revokes the token only, identity stays) / **delete** (removes the person from
  the platform and clears device ownership).
- **Deleting a digital employee**: console agent list → *Delete* (requires typing the agent name), or
  `DELETE /api/admin/agents/:id?confirm=<agent-name>`. It revokes device tokens and clears sessions
  and unused binding codes; historical runs and traces are kept (listed as "deleted agent"). Running
  `sa login` on that machine binds it again.
- Changing computers requires `sa agents add` again (workspaces are local config); `login` does not
  clear the existing workspace list.
- Binding codes are 6 digits, valid for 5 minutes, single-use; the database stores only an HMAC, so a
  leaked database cannot be reversed into codes.
- Device tokens are issued once at binding time and stored as SHA-256; revocation takes effect
  immediately.
- New computer, same person: `login` again (the new device displaces the old one). New person, same
  machine: the admin clicks *Force offline* first, then the person logs in.

## Tracing

Two levels:

| Level | Content | Purpose |
|---|---|---|
| Run-level `runs` | who started it, in which conversation, prompt, status, duration, tokens, final result, error | statistics and accountability for admins |
| Step-level `steps` | `llm` / `tool` / `message` / `thinking` / `error`, with tool name, input/output digests, duration, tokens, failure flag | find out what it actually did |

- Inputs and outputs are **redacted before storage**: `sk-*`, `LTAI*`, `AKIA*`, Bearer tokens,
  `password/token/secret=`, connection-string passwords and private key blocks are all replaced
  with `***`.
- Step details are kept for `TRACE_RETENTION_DAYS` days (default 7); expiry deletes step details
  only, run records and aggregates are kept.
- Steps are idempotent via a unique `(run_id, seq)` constraint, so gateway retries never duplicate.

## Protocol (bridge ↔ platform)

Everything is outbound from the gateway; the platform never connects to employee machines.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/bridge/register` | — | Register a device, returns a 6-digit binding code |
| POST | `/api/bridge/enroll/poll` | — | Poll for the binding result; the device token is issued once on success |
| POST | `/api/bridge/poll` | Bearer | Long poll for tasks (default 25s hold) and report idle/busy state + primary workspace dir/responsibility |
| POST | `/api/bridge/runs/:id/ack` | Bearer | Claim confirmation, renews the lease |
| POST | `/api/bridge/runs/:id/steps` | Bearer | Batch step upload (idempotent) |
| POST | `/api/bridge/runs/:id/report` | Bearer | Terminal state, result, usage, runtime session, actual cwd |
| GET | `/api/health` | — | Health check |

**There is no separate heartbeat endpoint**: long polling is the heartbeat. The `poll` body carries
`state` (idle/busy) and `activeRuns`, from which the platform derives liveness and load — one less
link, one less place for state to drift.

## Data model (SQLite, single file)

| Table | Description |
|---|---|
| `agents` | Feishu person ↔ agent: only primary agents are stored (`is_primary = 1`); `cwd`/`description` come from the gateway heartbeat; workspaces live on the employee machine |
| `devices` | Device, machine fingerprint, token hash, last heartbeat, idle/busy state |
| `enroll_codes` | Binding code hash, expiry, single-use token transfer column |
| `conversations` | Agent + Feishu conversation + thread → runtime sessionRef (multi-turn continuation) |
| `runs` | Run record, lease, usage, final result |
| `steps` | Step-level trace, unique `(run_id, seq)` |
| `skills` | Skill aggregate: name, summary, category, tags, owner, status, total downloads |
| `skill_versions` | One zip per version: version, size, SHA-256, file list, SKILL.md preview, downloads |
| `skill_downloads` | Download records for auditing and statistics |
| `audit_logs` | Admin and employee action audit |

Why one file: backup = copy the file; migration = runs at startup; write pressure for 500 agents
(heartbeat ≈ 20 writes/s) is far below what a single-writer SQLite can handle.

## Configuration

All configuration is via environment variables; no credentials live in the repo.

| Variable | Default | Description |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Listen address |
| `DATA_DIR` | `./data` | SQLite, logs and Skill packages (`/data` in the container) |
| `ADMIN_PASSWORD` | required | Admin console password (≥ 8 chars) |
| `ADMIN_SESSION_SECRET` | derived | Session and binding-code signing secret |
| `PUBLIC_BASE_URL` | empty | Enables the QR-code binding flow |
| `FEISHU_ENABLED` | `true` | Set to false to boot without Feishu (local integration) |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | required | Feishu self-built app credentials |
| `FEISHU_OPEN_BASE` | `https://open.feishu.cn` | Use `open.larksuite.com` for Lark international |
| `FEISHU_OAUTH_REDIRECT_URI` | empty | Callback for one-step QR binding |
| `FEISHU_WEB_REDIRECT_URI` | derived | Employee Feishu login callback; defaults to `${PUBLIC_BASE_URL}/api/auth/feishu/callback` |
| `AGENT_TIMEOUT_SEC` | `1800` | Per-task timeout |
| `POLL_HOLD_MS` | `25000` | Long-poll hold time, must be below the reverse proxy idle timeout |
| `RUN_LEASE_MS` | `120000` | Task lease; expired leases are requeued |
| `RUN_MAX_ATTEMPTS` | `3` | Maximum re-deliveries |
| `ONLINE_WINDOW_SEC` | `60` | Liveness window |
| `ENROLL_TTL_SEC` | `300` | Binding code TTL |
| `TRACE_RETENTION_DAYS` | `7` | Step detail retention |
| `TRACE_MAX_SUMMARY_CHARS` | `2000` | Max characters per trace summary |
| `SKILL_MAX_BYTES` | `20971520` | Max compressed Skill package size (20 MB) |
| `SKILL_MAX_EXTRACTED_BYTES` | `83886080` | Max extracted Skill package size (80 MB) |
| `SKILL_MAX_FILES` | `800` | Max files in a Skill package |
| `LOG_LEVEL` | `info` | `info` / `warn` / `error` |

On the gateway side: `STAFF_AGENT_HOME` (data directory),
`STAFF_AGENT_PI_BIN` / `STAFF_AGENT_CLAUDE_BIN` / `STAFF_AGENT_CODEX_BIN` (executable paths),
`STAFF_AGENT_*_ARGS` (extra launch arguments).

## Operations

```bash
# Logs
docker logs -f staff-agent-platform

# Backup (WAL mode: use SQLite online backup for consistency)
docker compose exec platform node -e "
const {DatabaseSync}=require('node:sqlite');
new DatabaseSync('/data/staff-agent.db').exec(\"VACUUM INTO '/data/backup.db'\")"

# Upgrade
git pull && docker compose up -d --build

# Migrations (automatic at startup, also runnable standalone)
docker compose exec platform pnpm --filter @staff-agent/platform migrate
```

Troubleshooting order:

1. `GET /api/health` for platform and Feishu connection state;
2. console: is the agent online (last heartbeat < 60s)?
3. on the employee machine, run `sa doctor`;
4. read `~/.staff-agent/logs/bridge.log` and `docker logs`;
5. stuck task: check `runs.lease_expires_at` — expired leases return to the queue automatically.
6. task fails immediately with `spawn xxx ENOENT`: either the runtime CLI is not on PATH
   (background daemons started by launchd get a minimal PATH; the gateway additionally searches
   `~/.pi/agent/bin`, `~/.local/bin`, `/opt/homebrew/bin`, …), or the configured working directory
   does not exist (the gateway auto-creates it with `mkdir -p`; the task only fails if that fails).

## Repository layout

```
staff-agent-platform/
├── apps/
│   ├── platform/            # platform service
│   │   └── src/
│   │       ├── db/          # SQLite connection and migrations
│   │       ├── domain/      # agents / devices / runs / steps / enroll / skills
│   │       ├── feishu/      # WebSocket client, web authorization
│   │       ├── http/        # bridge / admin / auth / skills / bind routes
│   │       ├── services/    # binding, dispatch, outbox, notifications, skill storage, web sessions
│   │       └── trace/       # redaction, statistics
│   └── web/                 # admin console + Skill marketplace (React + Vite)
├── packages/
│   ├── shared/              # protocol types and zod schemas (server, web, gateway)
│   └── bridge/              # employee-side npm package (CLI + 3 runtime adapters)
│       └── src/
│           ├── routing.ts   # local workspace routing: #name / #list / prompt assembly
│           ├── agents.ts    # workspace CRUD (writes only the local config.json)
│           └── runner.ts    # task execution + trace upload (incl. actual cwd)
├── docker-compose.yml
├── Dockerfile
└── .env.example
```

## Known limitations

- A Feishu long connection allows only one instance per app; multiple instances require switching to
  HTTP event subscription.
- Text messages only; images, files and voice are not forwarded to the agent yet.
- Group chats require `@bot + @person`; there is no implicit routing to "whoever ran it last".
- Tasks for one agent run serially, queued in arrival order (workspaces are directories, not parallel
  to the primary agent).
- The platform does not proxy model calls; model quota and credentials are managed by each employee's
  local CLI.
- The Skill marketplace shares packages by signed-in identity and has no approval workflow or secret
  scanning; make sure packages contain no credentials or sensitive internal data before uploading.

---

<div align="center">
<sub>Release history: <a href="CHANGELOG.md">CHANGELOG.md</a> · Questions? Open an issue.</sub>
</div>
