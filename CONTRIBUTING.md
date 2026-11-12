# 贡献流程

`main` 是受保护分支：所有改动走分支 + PR，CI（typecheck / build）全绿后才能合并。

## 1. 开分支

从最新 `main` 拉分支，命名前缀和提交类型保持一致：

```bash
git switch main && git pull --ff-only
git switch -c feat/skill-marketplace   # feat/ fix/ refactor/ docs/ chore/
```

## 2. 开发与自检

```bash
pnpm install
pnpm typecheck
pnpm build
```

涉及数据库时同步写 migration（`apps/platform/src/db/migrations.ts`）并在 `CHANGELOG.md`
的 `Unreleased` 段记录；新增配置项同时更新 `.env.example` 与 README。

## 3. 提交

沿用 Conventional Commits，一条提交一个意图：

```
feat(skills): 新增 Skill 广场上传与下载
fix(bridge): 修复 enroll 重试时 token 覆盖
```

不要提交 `.env`、密钥、内网地址；`.env` 与 `data/` 已在 `.gitignore` 中。

## 4. 开 PR

```bash
git push -u origin feat/skill-marketplace
gh pr create --fill            # 或网页开 PR，模板会自动带上
```

PR 描述按 `.github/pull_request_template.md` 填写：变更内容 / 影响面 / 验证步骤 / 检查清单。

## 5. 合并

- CI 通过 + 至少 1 个 approve 后 squash merge，标题用 PR 标题（保证 main 历史线性）。
- 合并后删除远端分支：`git push origin --delete <branch>`。
- 发版时在 `CHANGELOG.md` 把 `Unreleased` 改成版本号，并按 README 的发布流程同步版本号
  （根目录 + `apps/*` + `packages/*` 一套版本，网关版本取自 `packages/bridge/src/version.ts`）。

## 仓库管理员：启用 main 保护

`Settings → Rules → Rulesets → New branch ruleset`，目标 `main`，勾选：

- Require a pull request before merging（Required approvals: 1，Require conversation resolution）
- Require status checks to pass（`CI / check`，即本仓库 `ci.yml` 的 job）
- Block force pushes / Restrict deletions

或用 API 一次建好（需要 `gh auth login`）：

```bash
gh api -X POST repos/xiaoxia-mi/staff-agent-platform/rulesets --input - <<'JSON'
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
      } },
    { "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [{ "context": "check" }]
      } },
    { "type": "non_fast_forward" },
    { "type": "deletion" }
  ]
}
JSON
```
