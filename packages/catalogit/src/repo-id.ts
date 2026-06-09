/**
 * Maps a GitHub `owner/repo` pair to a catalogit id and per-project filename.
 *
 * Slug rules are derived from the data-format spec
 * (`../../../specs/agentic-development/catalogit/specs/data-format.md` §Spine reference):
 * - owner: `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`
 * - slug:  `^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$`
 *
 * Both parts are lowercased before validation; if either fails its pattern
 * a skip result is returned rather than throwing.
 */

/** Pattern an owner segment must satisfy after lowercasing. */
const OWNER_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Pattern a repo-slug segment must satisfy after lowercasing. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/;

export type MapResult =
  | { readonly ok: true; readonly id: string; readonly owner: string; readonly slug: string; readonly filename: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Converts a catalog id (`"owner/slug"`) to the per-project YAML filename
 * (`"owner_slug.yaml"`). Owners never contain underscores, so the first `/`
 * is the only ambiguous character.
 */
export function idToFilename(id: string): string {
  const slash = id.indexOf("/");
  const owner = id.slice(0, slash);
  const slug = id.slice(slash + 1);
  return `${owner}_${slug}.yaml`;
}

/**
 * Maps a GitHub `owner` + `repo` to a {@link MapResult}.
 *
 * Both segments are lowercased before pattern validation. Returns an
 * `ok: false` result (never throws) when either segment is invalid.
 */
export function mapRepoToId(owner: string, repo: string): MapResult {
  const normalizedOwner = owner.toLowerCase();
  const slug = repo.toLowerCase();

  if (!OWNER_RE.test(normalizedOwner)) {
    return { ok: false, reason: `owner "${normalizedOwner}" is not a valid catalog owner slug` };
  }
  if (!SLUG_RE.test(slug)) {
    return { ok: false, reason: `repo name "${slug}" is not a valid catalog slug` };
  }

  const id = `${normalizedOwner}/${slug}`;
  return { ok: true, id, owner: normalizedOwner, slug, filename: idToFilename(id) };
}
