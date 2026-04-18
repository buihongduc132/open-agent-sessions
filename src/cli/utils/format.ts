/**
 * Shared formatting utilities for CLI output.
 *
 * DRY consolidation of patterns used across list.ts, tree.ts, children.ts,
 * search.ts, and other CLI commands.
 */

/**
 * Sanitize a title string by collapsing carriage returns and newlines
 * into single spaces.  Used before displaying session titles in
 * compact single-line output formats.
 *
 * Previously inlined as `.replace(/[\r\n]+/g, " ")` in list.ts, tree.ts,
 * children.ts, and search.ts.
 */
export function sanitizeTitle(title: string): string {
  return title.replace(/[\r\n]+/g, " ");
}
