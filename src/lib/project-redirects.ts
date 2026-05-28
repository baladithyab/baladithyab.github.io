/**
 * Slug-rename redirects for the projects collection.
 *
 * When a project's slug is renamed (e.g. cse-160-asg2 → cse-160), the
 * old URL needs to keep working for inbound links and bookmarks. This
 * map is the single source of truth; both Astro middleware (handles
 * `/projects/<old-slug>`) and the personal-site CDN (could later cache
 * 308s) consult it.
 *
 * Add a new entry whenever a slug is renamed; never remove old ones.
 */
export const PROJECT_SLUG_REDIRECTS: Readonly<Record<string, string>> = Object.freeze({
  // 2026-05-27: project broadened from a single asg2 demo to a
  // multi-asset manifest covering the whole graphics course
  // (asg0/asg1/asg2 demos + 4 LaTeX writeups).
  'cse-160-asg2': 'cse-160',
})
