/**
 * The ship-it step registry — one entry per lifecycle step the ticket
 * workflow can route to (via `statusSkillMap`). `released` is the
 * per-step launch switch: develop a step on its own branch, merge it with
 * `released: false` (dark), and flip the one boolean when it's ready to
 * take real traffic. Tickets routed to an unreleased step get an advisory
 * skip — never a failure or DLQ.
 *
 * A step's name doubles as its skill entrypoint name. A released step
 * must also be declared in `agent.yaml` `skills.entrypoints` and have a
 * runner in the handler's dispatch table — `runSkill` and the handler
 * enforce both, and a registry test pins the invariant.
 */
export interface ShipItStep {
  readonly released: boolean;
  /** Short human note surfaced in skip logs (phase plan / why dark). */
  readonly note: string;
}

export const SHIP_IT_STEPS: Readonly<Record<string, ShipItStep>> = {
  "code-it": {
    released: true,
    note: "phase 1 — implement a ready ticket as a draft PR",
  },
  "review-it": {
    released: false,
    note: "phase 2 — independent AI review of ready-for-review PRs (implemented, dark)",
  },
  "spec-it": {
    released: false,
    note: "phase 3 — iterate the specification on the ticket (implemented, dark)",
  },
  "groom-it": {
    released: false,
    note: "later — turn a raw ticket into a clear, product-ready one (implemented, dark)",
  },
  "mock-it-up": {
    released: false,
    note: "later — optional design mockups during grooming (needs a design-tool seam first)",
  },
  "validate-it": {
    released: false,
    note: "later — verify the deployed change actually works (needs deploy-env contracts; may split into its own agent)",
  },
};

export function releasedSteps(): ReadonlyArray<string> {
  return Object.entries(SHIP_IT_STEPS)
    .filter(([, step]) => step.released)
    .map(([name]) => name);
}
