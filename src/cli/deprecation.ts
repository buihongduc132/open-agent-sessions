// BUG-10: deprecation notice helper.
//
// Policy:
// - Commands that are first-class/documented (see showHelp in bin/oas) MUST
//   NOT call this at all — users of documented commands should never be
//   scolded with DEPRECATED.
// - Genuinely-legacy aliases emit the notice AT MOST once per process and it
//   is fully suppressible with the OAS_QUIET=1 environment variable.

const shown = new Set<string>();

export function deprecationNotice(
  newCmd: string,
  write: (line: string) => void = (line) => process.stderr.write(line)
): void {
  if (process.env["OAS_QUIET"] === "1") return;
  if (shown.has(newCmd)) return;
  shown.add(newCmd);
  write(`DEPRECATED: use '${newCmd}' instead.\n`);
}

/** Test hook: clear the once-per-process notice state. */
export function resetDeprecationNotices(): void {
  shown.clear();
}
