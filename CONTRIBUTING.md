# Contributing

`main` is protected: every change goes through a branch + pull request, and CI
(typecheck / build) must be green before merge.

## 1. Create a branch

Branch off the latest `main`. The prefix matches the commit type:

```bash
git switch main && git pull --ff-only
git switch -c feat/skill-marketplace   # feat/ fix/ refactor/ docs/ chore/
```

## 2. Implement and self-check

```bash
pnpm install
pnpm typecheck
pnpm build
```

If you touch the database, add a migration in `apps/platform/src/db/migrations.ts`
and record it under `Unreleased` in `CHANGELOG.md`. New config vars go into
`.env.example` and the README at the same time.

## 3. Commit

Use Conventional Commits, one intent per commit, written in English:

```
feat(skills): add skill marketplace upload and download
fix(bridge): stop enroll retry from overwriting the token
```

Never commit `.env`, secrets, or internal hostnames — `.env` and `data/` are
already gitignored.

## 4. Open a pull request

```bash
git push -u origin feat/skill-marketplace
gh pr create --fill            # or open it in the browser, the template loads automatically
```

Fill in the description following `.github/pull_request_template.md`: what
changed, impact, verification, checklist.

## 5. Merge

- Merge with squash once CI is green and the PR has one approval, using the PR
  title as the commit subject (keeps `main` linear).
- Delete the remote branch afterwards: `git push origin --delete <branch>`.
- Release: turn `Unreleased` in `CHANGELOG.md` into a version heading and bump the
  version across the root plus `apps/*` and `packages/*` (one version per repo; the
  bridge reads it from `packages/bridge/src/version.ts`).

## Maintainers: enabling the `main` ruleset

`Settings → Rules → Rulesets → New branch ruleset`, target `main`, then enable:

- Require a pull request before merging (required approvals: 1, require conversation resolution)
- Require status checks to pass (`check`, the job in `.github/workflows/ci.yml`)
- Block force pushes and restrict deletions

Or create it with one API call (needs `gh auth login`):

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
