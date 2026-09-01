/**
 * Export flag registry, parse + validation, conflict matrix, help text.
 * Contracts frozen in flow/plans/oas-export-turn-split-design.md.
 *
 * Invariants:
 * - Every flag value crosses the parser boundary as a STRING (never Number-coerced).
 * - Negative integer tokens ("-1") are VALUES for pending flags, never parsed as flags.
 * - Unknown flags, duplicates, domain violations and sink conflicts are all collected
 *   into one errors[] result with exitCode 2 (usage class).
 */
export interface ExportFlagValues {
  sessionRef?: string;
  from?: string;
  format?: "csf" | "markdown" | "text";
  output?: string;
  agent?: string;
  id?: string;
  type?: "consolidate" | "split_turn";
  dir?: string;
  prefix?: string;
  dryRun?: boolean;
  force?: boolean;
  fromRelative?: string;
  toRelative?: string;
  fromTurn?: string;
  toTurn?: string;
  withTypes: string[];
  rawWithFlags: string[];
}

export type FlagParseResult =
  | { ok: true; value: ExportFlagValues }
  | { ok: false; errors: string[]; exitCode: 2 };

// ---------------------------------------------------------------------------
// Registry — closed flag set. Help text and unknown-flag errors derive from it.
// ---------------------------------------------------------------------------

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "from",
  "format",
  "output",
  "agent",
  "id",
  "type",
  "dir",
  "prefix",
  "from-relative",
  "to-relative",
  "to",
]);

const BOOL_FLAGS: ReadonlySet<string> = new Set(["dry-run", "force", "help", "h"]);

const WITH_PREFIX = "with-";

const VALID_FLAGS_HELP =
  "--from, --from-relative, --to-relative, --to, --agent, --id, " +
  "--type, --dir, --prefix, --format, --output, --dry-run, --force, " +
  "--with-<type>, --help";

const INT_TOKEN = /^-?\d+$/;

/** Boolean =value forms accepted: true/1 → true, false/0 → false. */
function parseBoolEqform(name: string, raw: string): { ok: true; value: boolean } | { ok: false; error: string } {
  if (raw === "true" || raw === "1") return { ok: true, value: true };
  if (raw === "false" || raw === "0") return { ok: true, value: false };
  return { ok: false, error: `Invalid value for --${name}=${raw}: expected true/false/1/0` };
}

export function parseExportFlags(argv: string[]): FlagParseResult {
  const errors: string[] = [];
  const seen = new Set<string>();
  const raw: Record<string, string | boolean> = {};
  const rawWithFlags: string[] = [];
  let sessionRef: string | undefined;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      const key = eq === -1 ? body : body.slice(0, eq);
      const inline = eq === -1 ? undefined : body.slice(eq + 1);

      if (key === "") {
        errors.push(`Invalid flag: '${arg}'`);
        i++;
        continue;
      }

      // --with-* family (prefix wildcard, boolean semantics)
      if (key.startsWith(WITH_PREFIX)) {
        let on = true;
        if (inline !== undefined) {
          const parsed = parseBoolEqform(key, inline);
          if (!parsed.ok) {
            errors.push(parsed.error);
            i++;
            continue;
          }
          on = parsed.value;
        }
        if (seen.has(key)) errors.push(`Duplicate flag --${key}`);
        seen.add(key);
        if (on && !rawWithFlags.includes(key)) rawWithFlags.push(key);
        i++;
        continue;
      }

      // closed boolean flags
      if (BOOL_FLAGS.has(key)) {
        let value = true;
        if (inline !== undefined) {
          const parsed = parseBoolEqform(key, inline);
          if (!parsed.ok) {
            errors.push(parsed.error);
            i++;
            continue;
          }
          value = parsed.value;
        }
        if (seen.has(key)) errors.push(`Duplicate flag --${key}`);
        seen.add(key);
        raw[key] = value;
        i++;
        continue;
      }

      // closed value flags
      if (VALUE_FLAGS.has(key)) {
        if (seen.has(key)) errors.push(`Duplicate flag --${key}`);
        seen.add(key);

        let value: string | undefined = inline;
        if (value === undefined) {
          const next = argv[i + 1];
          if (next === undefined) {
            errors.push(`Missing value for --${key}`);
          } else {
            // optarg rule: the token after a value-taking flag is its VALUE,
            // even when it starts with '-' (negative ints, '--'-prefixed ids).
            value = next;
            i++;
          }
        }
        if (value !== undefined) raw[key] = value;
        i++;
        continue;
      }

      errors.push(`Unknown flag --${key}. Valid flags: ${VALID_FLAGS_HELP}`);
      i++;
      continue;
    }

    if (arg.startsWith("-") && arg !== "-") {
      if (INT_TOKEN.test(arg)) {
        errors.push(`Unexpected argument '${arg}' (negative ints are values, not flags)`);
        i++;
        continue;
      }
      const key = arg.slice(1);
      if (BOOL_FLAGS.has(key)) {
        if (seen.has(key)) errors.push(`Duplicate flag -${key}`);
        seen.add(key);
        raw[key] = true;
        i++;
        continue;
      }
      errors.push(`Unknown flag -${key}. Valid flags: ${VALID_FLAGS_HELP}`);
      i++;
      continue;
    }

    // bare token → positional session-ref (first one only)
    if (sessionRef === undefined) {
      sessionRef = arg;
    } else {
      errors.push(`Unexpected argument '${arg}'`);
    }
    i++;
  }

  const value = mapRawToValues(raw, rawWithFlags, sessionRef, errors);
  if (errors.length > 0) {
    return { ok: false, errors, exitCode: 2 };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Raw → typed values (routing + domain validation)
// ---------------------------------------------------------------------------

function mapRawToValues(
  raw: Record<string, string | boolean>,
  rawWithFlags: string[],
  sessionRef: string | undefined,
  errors: string[]
): ExportFlagValues {
  const value: ExportFlagValues = { withTypes: [], rawWithFlags };
  if (sessionRef !== undefined) value.sessionRef = sessionRef;

  // --from is dual-purpose: /^
  // --from is dual-purpose: /^\d+$/ → absolute turn bound (fromTurn) ONLY when a
  // turn-mode sink/context exists (--dir or --output); otherwise a digit-only --from
  // is ambiguous with a legacy numeric session id → explicit error, never silent
  // reclassification. Other non-numeric → legacy session-ref SPEC (from).
  const fromRaw = raw["from"];
  const turnCtx = hasVal(raw["dir"]) || hasVal(raw["output"]);
  if (typeof fromRaw === "string") {
    if (/^\d+$/.test(fromRaw) && turnCtx) value.fromTurn = fromRaw;
    else if (/^\d+$/.test(fromRaw))
      errors.push(
        `--from '${fromRaw}' is ambiguous: numeric values are turn bounds only in --dir/--output mode; ` +
          `for a session id use --agent <kind> --id <id>, or add --dir`
      );
    else if (INT_TOKEN.test(fromRaw))
      errors.push(
        `--from must be a non-negative turn index (got '${fromRaw}'); ` +
          `for backwards counting use --from-relative`
      );
    else value.from = fromRaw;
  }
  const toRaw = raw["to"];
  if (typeof toRaw === "string") {
    if (/^\d+$/.test(toRaw) && turnCtx) value.toTurn = toRaw;
    else if (/^\d+$/.test(toRaw))
      errors.push(
        `--to '${toRaw}' is a turn bound only in --dir/--output mode; ` +
          `for a session id use --agent <kind> --id <id>, or add --dir`
      );
    else errors.push(`--to must be a non-negative turn index (got '${toRaw}')`);
  }
  function hasVal(v: string | boolean | undefined): boolean {
    return v !== undefined;
  }

  // Relative bounds: pandas domain (<= 0). Positive → hint at absolute flags.
  const fromRel = raw["from-relative"];
  if (typeof fromRel === "string") {
    if (!INT_TOKEN.test(fromRel))
      errors.push(`--from-relative must be an integer <= 0 (got '${fromRel}')`);
    else if (fromRel === "-0") errors.push(`--from-relative does not accept -0; use 0`);
    else if (Number(fromRel) > 0)
      errors.push(
        `--from-relative must be <= 0 (0 = current turn, -1 = previous); ` +
          `for counting from the first turn use --from`
      );
    else value.fromRelative = fromRel;
  }
  const toRel = raw["to-relative"];
  if (typeof toRel === "string") {
    if (!INT_TOKEN.test(toRel))
      errors.push(`--to-relative must be an integer <= 0 (got '${toRel}')`);
    else if (toRel === "-0") errors.push(`--to-relative does not accept -0; use 0`);
    else if (Number(toRel) > 0)
      errors.push(
        `--to-relative must be <= 0 (0 = current turn, -1 = previous); ` +
          `for an absolute last turn use --to`
      );
    else value.toRelative = toRel;
  }

  const typeRaw = raw["type"];
  if (typeof typeRaw === "string") {
    if (typeRaw === "consolidate" || typeRaw === "split_turn") value.type = typeRaw;
    else errors.push(`Invalid --type value '${typeRaw}': must be consolidate or split_turn`);
  }

  const formatRaw = raw["format"];
  if (typeof formatRaw === "string") {
    if (formatRaw === "csf" || formatRaw === "markdown" || formatRaw === "text")
      value.format = formatRaw;
    else errors.push(`Invalid --format value '${formatRaw}': must be one of csf, markdown, text`);
  }

  if (typeof raw["agent"] === "string") value.agent = raw["agent"];
  if (typeof raw["id"] === "string") value.id = raw["id"];
  if (typeof raw["dir"] === "string") value.dir = raw["dir"];
  if (typeof raw["prefix"] === "string") value.prefix = raw["prefix"];
  if (typeof raw["output"] === "string") value.output = raw["output"];

  if (raw["dry-run"] === true) value.dryRun = true;
  if (raw["dry-run"] === false) value.dryRun = false;
  if (raw["force"] === true) value.force = true;
  // help / h are accepted booleans consumed by the bin layer early-return;
  // no typed field in the frozen contract.

  // with-* family → additive-unique part types
  for (const wf of rawWithFlags) {
    if (wf === "with-tools") {
      pushUnique(value.withTypes, "tool");
      pushUnique(value.withTypes, "tool_result");
    } else if (wf === "with-thinking") {
      pushUnique(value.withTypes, "reasoning");
    } else {
      pushUnique(value.withTypes, wf.slice(WITH_PREFIX.length));
    }
  }

  checkConflicts(value, errors);
  return value;
}

function pushUnique(list: string[], item: string): void {
  if (!list.includes(item)) list.push(item);
}

// ---------------------------------------------------------------------------
// Conflict matrix (usage class, exitCode 2)
// ---------------------------------------------------------------------------

function checkConflicts(value: ExportFlagValues, errors: string[]): void {
  const hasDir = value.dir !== undefined;
  const hasOutput = value.output !== undefined;
  const hasTargeting =
    value.agent !== undefined ||
    value.id !== undefined ||
    value.from !== undefined ||
    value.sessionRef !== undefined;
  const hasBounds =
    value.fromRelative !== undefined ||
    value.toRelative !== undefined ||
    value.fromTurn !== undefined ||
    value.toTurn !== undefined;

  // Unconditional targeting conflicts.
  if (value.id !== undefined && value.agent === undefined)
    errors.push("--id requires --agent to know which agent owns the session");
  if (value.id !== undefined && value.from !== undefined)
    errors.push("--id and --from are mutually exclusive; target the session via one of them");

  // Unconditional flag-pair conflicts.
  if (value.from !== undefined && value.fromRelative !== undefined)
    errors.push("--from and --from-relative are mutually exclusive (session-ref/absolute vs relative)");
  if (value.fromTurn !== undefined && value.fromRelative !== undefined)
    errors.push("--from and --from-relative are mutually exclusive (absolute vs relative)");
  if (value.toTurn !== undefined && value.toRelative !== undefined)
    errors.push("--to and --to-relative are mutually exclusive (absolute vs relative)");
  if (hasOutput && hasDir)
    errors.push("--output and --dir are mutually exclusive (single file vs one file per turn)");
  // --output is the legacy single-file sink: dir-mode modifiers make no sense there.
  // Absolute bounds ARE valid with --output (ranged single-file export); relative
  // bounds + preview/naming flags are dir-mode only.
  if (hasOutput) {
    if (value.type !== undefined)
      errors.push("--type requires --dir (turn-file export mode), not --output");
    if (value.dryRun === true)
      errors.push("--dry-run requires --dir (preview of turn files), not --output");
    if (value.prefix !== undefined)
      errors.push("--prefix requires --dir (turn-file naming), not --output");
    if (value.fromRelative !== undefined || value.toRelative !== undefined)
      errors.push("relative turn bounds require --dir, not --output");
  }
  // Positional + --from are two competing targets — never silently prefer --from.
  if (value.sessionRef !== undefined && value.from !== undefined)
    errors.push("positional <session-ref> and --from are mutually exclusive; target via one of them");

  // Positional vs flag targeting agreement.
  if (value.sessionRef !== undefined) {
    const parts = value.sessionRef.split(":");
    const refId = parts[parts.length - 1];
    if (value.id !== undefined && value.id !== refId)
      errors.push(`--id '${value.id}' conflicts with session ref '${value.sessionRef}' (id '${refId}')`);
    if (parts.length === 3 && value.agent !== undefined && parts[0] !== value.agent)
      errors.push(`--agent '${value.agent}' conflicts with session ref agent '${parts[0]}'`);
  }

  // Dir-mode flags require a sink (--dir) once a session has been targeted.
  // Without targeting the command layer reports the missing session ref, so the
  // parser stays silent there (pure parse-level invocations like
  // `--from-relative=-3 --to-relative 0` remain valid).
  if (hasTargeting && !hasDir && !hasOutput) {
    if (value.type !== undefined)
      errors.push("--type requires --dir (turn-file export mode)");
    if (value.dryRun === true)
      errors.push("--dry-run requires --dir (preview of turn files)");
    if (value.prefix !== undefined)
      errors.push("--prefix requires --dir (turn-file naming)");
    if (hasBounds)
      errors.push("turn bounds (--from/--to/--from-relative/--to-relative) require --dir (or --output)");
  }
}

// ---------------------------------------------------------------------------
// Help — relative usage leads, absolute second (LD8)
// ---------------------------------------------------------------------------

export function exportHelpText(): string {
  return `Export a session, optionally as per-turn files.

Usage:
  oas export <session-ref> --dir <dir> [options]
  oas export --agent <kind> --id <session-id> --dir <dir> [options]

Turn ranges — relative (recommended):
  Relative indexes count backwards from the current turn (pandas-style):
  0 = current turn, -1 = previous turn, -2 = two turns back, ...

  oas export <ref> --from-relative=-3 --to-relative 0   # last 4 turns
  oas export <ref> --from-relative=-1                   # last 2 turns (T-2..T-1)

  Turns are 0-based turn indexes. (This differs from 'oas read --range',
  which selects 1-based message indexes.)

Turn ranges — absolute:
  --from N   first turn index, 0-based (>= 0)
  --to N     last turn index, 0-based (>= 0, inclusive)

  oas export <ref> --from 0 --to 2                       # first 3 turns

Output:
  --dir DIR             target directory (created if missing); one file per turn
  --type consolidate    single combined file (default: split_turn)
  --prefix PREFIX       file name prefix (default: YYYY-MM-DD)
  --dry-run             preview only: first/last 200 chars per turn, tool stats
  --force               overwrite existing files that differ
  --with-tools          include tool and tool_result parts
  --with-thinking       include reasoning parts
  --with-<type>         include parts of an arbitrary type

Session targeting:
  <session-ref>         session_id | alias:session_id | agent:alias:session_id
  --agent KIND          agent kind (e.g. pi, codex, claude)
  --id ID               session id (requires --agent)

Legacy single-file mode:
  --format FORMAT       csf (default), markdown, text
  --output FILE         write a single file instead of stdout
  --from SPEC           session reference in legacy form

Exit codes:
  0   ok
  2   usage errors and conflicts (including collision refusal)
  3   runtime errors (dir mode only; legacy paths keep exit 1)`;
}
