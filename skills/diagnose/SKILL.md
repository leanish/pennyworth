---
name: diagnose
description: Disciplined diagnosis loop for hard bugs and performance regressions. Reproduce → minimise → hypothesise → instrument → fix → regression-test.
---

# diagnose

Support skill for debugging workflows. When the user's question is about a bug, a failure, or a performance regression, work through the loop below rather than guessing:

1. **Reproduce.** Get a deterministic case. If the user says "it sometimes happens", find the conditions under which it always happens. Don't move on until you can trigger the symptom on demand.
2. **Minimise.** Strip the repro down to the smallest input / shortest path that still triggers the symptom. Removed steps that don't matter make the remaining steps load-bearing — that's the signal.
3. **Hypothesise.** Form a concrete hypothesis ("X is happening because Y") and a check that would distinguish it from the alternatives. Vague hypotheses give vague evidence.
4. **Instrument.** Add the minimum logging / breakpoint / counter that lets you confirm or reject the hypothesis. If you'd need to re-run the failing case to learn something useful, do that.
5. **Fix.** Once the mechanism is understood, the fix is usually small. Resist the urge to "improve the area" — that hides the lesson.
6. **Regression-test.** Add a test that fails before the fix and passes after. If the symptom was a behaviour the test suite didn't cover, that's worth noting in itself.

Bias against "let me try a few things and see what sticks." Each change you make without a hypothesis is a vote for "I don't understand this yet."
