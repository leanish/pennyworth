# leanish-skills

Personal agent skills, installable into your coding agents (Claude Code, Codex, …) with the
[`skills`](https://github.com/mattpocock/skills) CLI.

## Install

```sh
npx skills@latest add leanish/leanish-skills
```

Pick the skills and target agents when prompted. Each skill is then invoked using your agent's own
convention — e.g. `/leanish-review` in Claude Code, `$leanish-review` in Codex/OpenAI.

## Layout

Skills live under `skills/<category>/<name>/SKILL.md`. Two categories:

### `wip/` — leanish's own, work-in-progress

Our first-party skills, still being shaped. New leanish skills (e.g. `consult-codex`, coming) land
here too.

- [leanish-cleanup](./skills/wip/leanish-cleanup/SKILL.md) — simplify recently touched code,
  behavior-preserving.
- [leanish-dependency-upgrade](./skills/wip/leanish-dependency-upgrade/SKILL.md) — dependency
  freshness + CVE-driven upgrade triage.
- [leanish-review](./skills/wip/leanish-review/SKILL.md) — review PRs for high-confidence bugs and
  actionable threads.

### `third-party/` — vendored / external (not leanish-authored)

- [grill-me](./skills/third-party/grill-me/SKILL.md) — one-question-at-a-time grilling of a plan.
- [grill-with-docs](./skills/third-party/grill-with-docs/SKILL.md) — grill a plan against repo
  language; capture terminology / ADRs.
- [improve-codebase-architecture](./skills/third-party/improve-codebase-architecture/SKILL.md) —
  find architectural "deepening" opportunities.
- [karpathy-guidelines](./skills/third-party/karpathy-guidelines/SKILL.md) — LLM coding guardrails,
  derived from Andrej Karpathy's observations (MIT).

These are vendored from external repos ([mattpocock/skills](https://github.com/mattpocock/skills) and
[multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)), both MIT.
Full attribution, copyright notices, and license text are in
[skills/third-party/NOTICES.md](./skills/third-party/NOTICES.md); see also
[skills/third-party/README.md](./skills/third-party/README.md). Each skill directory is standalone
(its own `SKILL.md`) and can also be installed individually.
