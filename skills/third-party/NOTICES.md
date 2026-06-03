# Third-party notices

The skills in this directory are **vendored from external repositories** — not authored by the
leanish suite. Their original authors and licenses are retained here as the licenses require, and
**each skill directory carries its own `LICENSE`** so the notice travels with the skill when it is
installed individually (the installer copies only the skill directory, not this parent file). Each
skill is used as-is unless a local change is noted in its own directory.

## Attribution

| Skill | Source repository | License |
|---|---|---|
| `grill-me` | https://github.com/mattpocock/skills | MIT |
| `grill-with-docs` | https://github.com/mattpocock/skills | MIT |
| `improve-codebase-architecture` | https://github.com/mattpocock/skills | MIT |
| `karpathy-guidelines` | https://github.com/multica-ai/andrej-karpathy-skills | MIT |

`karpathy-guidelines` is itself **derived from Andrej Karpathy's public observations on LLM coding
pitfalls** (credited by the upstream repo); the skill's own `SKILL.md` declares `license: MIT`.

## Sync provenance

Last synced from upstream on **2026-05-31 12:06:30 EEST (+0300)**:

- `mattpocock/skills` @ `e3b90b5` — `grill-me`, `grill-with-docs`, `improve-codebase-architecture`
- `multica-ai/andrej-karpathy-skills` @ `2c60614` — `karpathy-guidelines`

Notes: upstream shares the `CONTEXT-FORMAT.md` and `ADR-FORMAT.md` files used by
`improve-codebase-architecture` with `grill-with-docs`; this package copies them into
`improve-codebase-architecture` too, so each skill remains individually installable. The
`agents/openai.yaml` adapter in each skill is a local install artifact, not upstream content.

## Copyright notices

Both upstreams are MIT-licensed. Their copyright notices, retained per the MIT terms:

- **Copyright (c) 2026 Matt Pocock** — https://github.com/mattpocock/skills
  (`grill-me`, `grill-with-docs`, `improve-codebase-architecture`)
- **Copyright (c) multica-ai** — https://github.com/multica-ai/andrej-karpathy-skills
  (`karpathy-guidelines`). The upstream repo declares MIT in its README and in the skill's `SKILL.md`
  frontmatter but **ships no standalone `LICENSE` file**, so there is no exact upstream copyright line
  to quote verbatim; "multica-ai" is the repository owner.

## MIT License

The above copyright holders license their work under the MIT License. Its terms (identical for both):

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

For the authoritative text, see [mattpocock/skills `LICENSE`](https://github.com/mattpocock/skills/blob/main/LICENSE);
the andrej-karpathy-skills repo declares MIT in its README without a separate `LICENSE` file.
