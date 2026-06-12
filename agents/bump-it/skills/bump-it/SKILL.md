---
name: bump-it
description: Full dependency-freshness + CVE pass over one project — deps, Gradle wrapper, workflow actions, Docker image pins, doc version references — folded into ONE draft upgrade PR.
compatibleCodingAgents:
  - claude-code
  - codex
inputSchema:
  type: object
  required: [project]
  properties:
    project:
      type: object
      required: [id, source]
      properties:
        id:
          type: string
        source:
          type: object
          required: [url]
          properties:
            url:
              type: string
            branch:
              type: string
outputSchema:
  type: object
  required: [summary, alerts, pullRequests]
  properties:
    summary:
      type: string
    alerts:
      type: array
      items:
        type: object
        required: [alertRef, outcome]
        properties:
          alertRef:
            type: string
          outcome:
            type: string
            enum: [pr-opened, pr-updated, already-fixed, unsupported, no-safe-fix]
    pullRequests:
      type: array
      items:
        type: object
        required: [alertRef, url, branch, number, title]
        properties:
          alertRef:
            type: string
          url:
            type: string
          branch:
            type: string
          number:
            type: number
          title:
            type: string
---

# bump-it — dependency freshness + CVE triage, one draft PR per project

You are running a full dependency-freshness and CVE pass over the project mounted in the working
copy (`<project.id>`). Triage with REAL repo state first; prefer CLI over browsing unless a primary
source is needed to verify a version or advisory. The result is **one batched draft PR** carrying
every safe upgrade — never one PR per dependency. A separate follow-up run (`bump-it-revisit`)
handles CI results later — you never wait for CI.

## Workflow

1. **Resolve the canonical repo identity** before querying anything:
   `gh repo view --json nameWithOwner,url,defaultBranchRef` and compare with `git remote -v`.
   Treat `gh repo view` as the source of truth for GitHub metadata.

2. **Enumerate open PRs unfiltered** (`gh pr list --state open --limit 30 --json
   number,title,author,headRefName,baseRefName,url`) before any filtered search. Identify Dependabot PRs from
   the full list; read their exact diffs (`gh pr diff <n> --patch`) and treat them as primary
   upgrade signals — FOLD their concrete changes into your upgrade branch instead of paraphrasing.

3. **Inventory every upgrade surface** before deciding anything is current:
   - direct dependencies in the build files (Gradle/Maven/npm — whatever the repo uses);
   - the **Gradle wrapper** version (`gradle/wrapper/gradle-wrapper.properties`) — Gradle itself is
     in scope;
   - **GitHub Actions** pins in `.github/workflows/*.yml` and local composite actions — they are
     dependencies too (omit `aws-actions/amazon-ecr-login` unless explicitly requested);
   - **Docker image pins** anywhere in the repo — test code (testcontainers image tags),
     `docker-compose*.yml`, Dockerfiles, CI service containers. A pinned image tag goes stale
     exactly like a library coordinate (`rg -n '(image:|DockerImageName|FROM )' …` finds most);
   - **version references in docs** — README/docs badges, install/usage snippets, documented tool
     versions. When a bump changes a version the docs state, the doc text is part of the upgrade;
   - never conclude "already up to date" from library coordinates alone.

4. **Discover candidates with a temporary updater** where the ecosystem has one (Gradle: add
   `com.github.ben-manes.versions` locally, run it, capture results, REMOVE it before commit).
   Verify interesting findings against primary sources (Maven Central / Gradle Plugin Portal /
   official action releases / Gradle releases) — not search snippets.

5. **Apply the upgrades on one branch**: `bump-it/dependency-refresh`.
   - Wrapper bumps: `./gradlew wrapper --gradle-version <target>` then `./gradlew wrapper` again;
     revert unrelated generated churn before committing.
   - Workflow actions: update the `uses:` pins deliberately.
   - Docker image pins and doc version references: update them on the same branch when the bump
     they track moved (or the pinned image itself has a newer stable tag) — don't leave docs or
     test pins contradicting the upgraded build.
   - Run the project's own quality gate locally (`./gradlew check` or equivalent) and fix what the
     upgrades broke when it's clearly mechanical; drop (and note) any single upgrade that can't be
     made safe — keep the rest.

6. **Verify the RESOLVED graph, not declarations**: `./gradlew dependencies --configuration
   runtimeClasspath` (+ `testRuntimeClasspath`), `dependencyInsight` where a floor needs proof. A
   bump hasn't happened until the resolved graph says so.

7. **CVE pass on the resolved graph**: check the concrete resolved artifacts (Netty, Apache
   HttpClient, Commons, Jackson, AWS SDK transitives, testcontainers are the usual suspects in
   Java repos; use primary advisory sources — GitHub Advisories, official project security pages,
   OSV). Also list open Dependabot ALERTS when accessible (`gh` may lack scopes — then say so in
   the summary and continue with graph-based triage; absence of alerts ≠ clean graph).
   - Add a version floor ONLY for a real resolved vulnerability, as an explicit dependency at the
     top of the dependencies block with `because("CVE-XXXX-NNNNN: <what it fixes>")`.
   - Remove stale CVE floors whose fallback resolution is already outside the affected range.

8. **Open or update the draft PR**:
   - branch `bump-it/dependency-refresh`, **draft** PR against the default branch, label
     `leanish:agent:bump-it`, marker footer `<!-- leanish:agent=bump-it; alertRef=dependency-refresh -->`;
   - PR body: what was upgraded (deps / wrapper / actions / image pins / docs), what was
     deliberately skipped and why,
     the CVE findings with their resolution state, and which Dependabot PRs it folds in
     (mention them with `Closes #<n>` ONLY when the fold is exact);
   - idempotent re-runs: if an open `bump-it/dependency-refresh` PR exists, UPDATE that branch
     (regular pushes) instead of opening a duplicate;
   - never wait for CI in-process; never merge; never force-push; never push to the default branch.

## Output mapping

- `alerts[]` — one entry per CVE/advisory you actively handled or consciously deferred:
  `alertRef` = the CVE/GHSA id, `outcome` ∈ pr-opened | pr-updated | already-fixed | unsupported |
  no-safe-fix. A pure freshness run with no advisories produces `[]`.
- `pullRequests[]` — the batched PR (single entry when one was opened/updated, empty when the repo
  was fully current): `alertRef: "dependency-refresh"`, plus the PR's real url/branch/number/title.
- `summary` — two-to-four sentences: what was current, what moved, what was skipped, CVE posture.

End your response with a single fenced JSON block as the final non-whitespace content, matching the
output schema:

```json
{ "summary": "…", "alerts": [ { "alertRef": "CVE-2026-12345", "outcome": "pr-opened" } ], "pullRequests": [ { "alertRef": "dependency-refresh", "url": "…", "branch": "bump-it/dependency-refresh", "number": 7, "title": "…" } ] }
```
