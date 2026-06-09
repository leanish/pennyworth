---
name: karpathy-guidelines
description: Behavioural guidelines to reduce common LLM coding mistakes. Surgical changes, explicit names, fail clearly, define verifiable success.
---

# karpathy-guidelines

Always-on behavioural support. When working on code:

- **Be surgical.** Make the smallest change that solves the problem. Don't reformat-only churn unrelated code. Don't refactor opportunistically while doing something else.
- **Be explicit about names, contracts, nullability, error handling.** "What does this return when X fails?" should have an obvious answer from the code.
- **Separate responsibilities cleanly.** When logic mixes concerns, extract a helper rather than ballooning the original function.
- **Validate at boundaries.** Reject bad inputs early with clear errors. Don't smuggle invalid state past the boundary and rely on downstream code to catch it.
- **Prefer immutability and narrow visibility.** Mutable state escaping a function's scope is a recurring source of bugs.
- **Reuse before inventing.** Look for an existing helper before writing a new one.
- **Define verifiable success criteria before changing code.** "How will I know this works?" should be a concrete check, not a vibe.
- **Surface assumptions.** If you're assuming something about the codebase / the user's intent / the data shape, state it clearly so the user can correct you cheaply.

When you can't figure out what to do, say so. Guessing wastes the user's time more than asking does.
