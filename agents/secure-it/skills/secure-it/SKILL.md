---
name: secure-it
description: Scan one project's open GitHub security alerts and open or update a draft fix PR per actionable alert.
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

# secure-it

You fix open security and dependency alerts for the single project mounted in the working set. For each actionable alert you produce one **draft** pull request with the narrowest dependency fix that resolves it, then report what you did as terminal JSON. A separate follow-up run (`secure-it-revisit`) handles CI results later — you never wait for CI.

## Frame

- `project.id` is the repo's full name (e.g. `owner/name`); `project.source.url` is its clone URL and `project.source.branch` (when present) the default branch. The repo is already cloned into the mounted working-copy directory — do your code work there.
- `GITHUB_TOKEN` is inherited in your environment. Use the `gh` CLI (or direct GitHub API calls) for everything GitHub-side: listing alerts, listing PRs, pushing, opening PRs, labeling.
- Resolve the canonical repo identity first (`gh repo view`) so alert and PR queries hit the right repository even if the clone URL is a mirror or redirect.

## Scan

1. List the project's open security alerts: `gh api repos/<owner>/<name>/dependabot/alerts --paginate` (state `open`). Include code-scanning/security advisories only if they map to a dependency fix; everything else is `unsupported`.
2. List existing open PRs (`gh pr list --state open --json number,headRefName,isDraft,labels,title,url`) **before** deciding anything — earlier runs may already have a PR per alert.
3. Derive a stable `alertRef` per alert — prefer the GHSA id; fall back to the Dependabot alert number (e.g. `dependabot-12`).

## Per-alert workflow

For each open alert, in a fresh branch context:

1. **Check for an existing PR.** The branch convention is `secure-it/<alertRef>`. If an open PR for that branch (or carrying the marker/label below for the same `alertRef`) exists, update it instead of opening a duplicate — record `pr-updated`.
2. **Verify the alert is real in the resolved graph.** Inspect the dependency surface the alert points at (lockfiles, manifests, build files, resolved dependency reports — e.g. `npm ls`, `./gradlew dependencyInsight`, `pip show`, whatever the ecosystem provides). If the resolved graph is already outside the vulnerable range, record `already-fixed` and move on — no PR.
3. **Apply the narrowest fix that resolves the alert.** Bump the affected dependency (or add the minimal constraint/override for a vulnerable transitive) to the smallest safe version. Verify against primary sources (the advisory, the package's release listing) — do not guess versions. Re-resolve the graph and prove the vulnerable version is gone before committing.
4. **Keep the change clean.** No unrelated upgrades, no formatting churn, no leftover scratch tooling. If a safe fix cannot be produced (no fixed release, fix requires a major rewrite, ecosystem you cannot operate), record `no-safe-fix` (or `unsupported`) with no PR.
5. **Publish as a draft PR.**
   - Branch: `secure-it/<alertRef>`, created from the default branch. Never force-push; if the branch exists, add commits or recreate the PR content idempotently.
   - Open the PR in **draft** mode (`gh pr create --draft`), or push updates to the existing one.
   - Label it `leanish:agent:secure-it` (create the label if missing).
   - End the PR body with the marker footer (machine-readable, survives edits above it):
     `<!-- leanish:agent=secure-it; alertRef=<alertRef> -->`
   - PR body: what the alert is, what changed, and how you verified the resolved graph no longer contains the vulnerable version.
6. **Do not wait for CI.** Pushing triggers the project's CI automatically; the revisit run reads the results later.

## Hard rules

- **Draft PRs only. Never merge a PR. Never mark one ready-for-review** — that is the revisit skill's decision.
- **Never force-push.**
- **Idempotent re-runs**: a second invocation over the same alert set must converge on the same PRs (update, not duplicate).
- Touch only what the fix requires.

## Output

End your response with a single fenced JSON block as the final non-whitespace content, matching the output schema:

- `summary` — one or two sentences on what the scan found and did.
- `alerts` — one entry per alert processed, with its `alertRef` and `outcome` (`pr-opened`, `pr-updated`, `already-fixed`, `unsupported`, `no-safe-fix`). This is the audit log.
- `pullRequests` — one entry per PR you opened or updated this run: `alertRef`, `url`, `branch`, `number`, `title`. Every `pr-opened` / `pr-updated` outcome must have a matching entry here; outcomes without a PR must not.

A clean scan with no open alerts returns `alerts: []` and `pullRequests: []` with a summary saying so.

```json
{
  "summary": "Scanned 2 open alerts; opened one draft PR, one alert already fixed.",
  "alerts": [
    { "alertRef": "GHSA-xxxx-yyyy-zzzz", "outcome": "pr-opened" },
    { "alertRef": "GHSA-aaaa-bbbb-cccc", "outcome": "already-fixed" }
  ],
  "pullRequests": [
    {
      "alertRef": "GHSA-xxxx-yyyy-zzzz",
      "url": "https://github.com/owner/name/pull/123",
      "branch": "secure-it/GHSA-xxxx-yyyy-zzzz",
      "number": 123,
      "title": "fix: bump vulnerable-package past GHSA-xxxx-yyyy-zzzz"
    }
  ]
}
```
