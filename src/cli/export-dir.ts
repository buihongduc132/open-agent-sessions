/**
 * Dir-mode export orchestration: plan/preflight/dry-run/write.
 * Contracts: flow/plans/oas-export-turn-split-design.md
 *
 * Exit codes: 0 ok · 2 usage errors + collision refusals · 3 runtime errors.
 * Report → stdout, errors/warnings → stderr.
 */
import type { CliResult } from "./types";
import type { SessionDetail } from "../core/types";
import type { ExportFlagValues } from "./export-options";
import { groupTurns, resolveRange, sliceTurn } from "../core/turns";
import { createFileSink } from "../core/export-sink";
import { toCsf, renderTurnBody, type PartFilter, type SliceMeta } from "../core/export";
import { safeStat, readTextFile } from "../adapters/fs-utils";
import { homedir } from "node:os";
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
} from "node:fs";
import { isAbsolute, join, resolve as pathResolve } from "node:path";

export interface DirExportDeps {
  config: { agents: ReadonlyArray<{ agent: string; alias: string; enabled: boolean }> };
  getSession: (
    query: { agent: string; alias: string; id: string },
    options?: { mode?: string }
  ) => Promise<SessionDetail | null>;
}

type ExportFormat = "csf" | "markdown" | "text";

interface Target {
  /** absolute output path */
  path: string;
  /** fully rendered file content */
  content: string;
  /** turn label for reports, e.g. "#0 (rel -2)" or "#0–2 (consolidated)" */
  label: string;
  /** tool-call stats (name → count) computed from the target's slice */
  toolStats: Map<string, number>;
}

const WINDOWS_INVALID = /[<>:"|?*]/;
const CONTROL_CHARS = /\u0000-\u0008\u000B-\u001F\u007F/;

function fail(exitCode: number, stderr: string): CliResult {
  return { exitCode, stdout: "", stderr: `${stderr.trim()}\n` };
}

function expandTilde(p: string): string {
  // Honor process.env.HOME at call time (tests flip it); fall back to os.homedir().
  const home = process.env.HOME ?? homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

function sanitizePrefix(prefix: string, dirAbs: string, ext: string): string | { error: string } {
  if (prefix.includes("/") || prefix.includes("\\")) {
    return { error: `Invalid --prefix "${prefix}": path separators are not allowed.` };
  }
  if (prefix.includes("..")) {
    return { error: `Invalid --prefix "${prefix}": ".." is not allowed.` };
  }
  // eslint-disable-next-line no-control-regex
  const ctrl = new RegExp(`[${CONTROL_CHARS}]`);
  if (ctrl.test(prefix)) {
    return { error: `Invalid --prefix: control characters are not allowed.` };
  }
  if (WINDOWS_INVALID.test(prefix)) {
    return {
      error: `Invalid --prefix "${prefix}": Windows-invalid characters (<>:"|?*) are not allowed.`,
    };
  }
  const totalPathLen = join(dirAbs, `${prefix}_0000.${ext}`).length;
  if (totalPathLen > 240) {
    return {
      error: `Invalid --prefix "${prefix}": resulting path exceeds 240 characters (${totalPathLen}).`,
    };
  }
  return prefix;
}

function localDatePrefix(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function yamlScalar(value: string | number): string {
  return JSON.stringify(String(value));
}

function buildFrontmatter(
  detail: SessionDetail,
  slice?: SliceMeta
): string {
  const lines: string[] = ["---"];
  lines.push(`title: ${yamlScalar(detail.title || detail.id)}`);
  lines.push(`agent: ${yamlScalar(detail.agent)}`);
  lines.push(`alias: ${yamlScalar(detail.alias)}`);
  lines.push(`id: ${yamlScalar(detail.id)}`);
  lines.push(`created_at: ${yamlScalar(detail.created_at)}`);
  lines.push(`updated_at: ${yamlScalar(detail.updated_at)}`);
  lines.push(`message_count: ${detail.message_count}`);
  if (detail.parentSessionId) {
    lines.push(`parent_session_id: ${yamlScalar(detail.parentSessionId)}`);
  }
  if (slice) {
    lines.push(
      `slice: {turn_start: ${slice.turn_start}, turn_end: ${slice.turn_end}, total_turns: ${slice.total_turns}}`
    );
  }
  lines.push("---");
  return lines.join("\n");
}

function extFor(format: ExportFormat): string {
  switch (format) {
    case "csf":
      return "json";
    case "text":
      return "txt";
    default:
      return "md";
  }
}

/** Count tool-CALL parts per tool name (tool_result parts never counted). */
function toolCallStats(messages: { parts: { type: string; tool?: unknown }[] }[]): Map<string, number> {
  const stats = new Map<string, number>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool") {
        const name = String(part.tool ?? "unknown");
        stats.set(name, (stats.get(name) ?? 0) + 1);
      }
    }
  }
  return stats;
}

function renderSliceContent(
  slice: SessionDetail,
  detail: SessionDetail,
  filter: PartFilter,
  format: ExportFormat,
  sliceMeta: SliceMeta,
  rangedHeader?: string
): string {
  if (format === "csf") {
    return JSON.stringify(toCsf(slice, { slice: sliceMeta }), null, 2) + "\n";
  }
  const parts: string[] = [];
  parts.push(buildFrontmatter(slice, sliceMeta));
  parts.push("");
  if (format === "markdown") {
    parts.push(`# ${slice.title || slice.id}`);
    parts.push("");
    parts.push(`**Agent:** \`${slice.agent}:${slice.alias}\` · **Session ID:** \`${slice.id}\``);
    parts.push("");
    if (rangedHeader) {
      parts.push(`> ${rangedHeader}`);
      parts.push("");
    }
  } else {
    parts.push(`Session: ${slice.title || slice.id}`);
    parts.push(`Agent: ${slice.agent}:${slice.alias}`);
    parts.push(`ID: ${slice.id}`);
    if (rangedHeader) {
      parts.push(rangedHeader);
    }
    parts.push("");
  }
  parts.push(renderTurnBody(slice.messages ?? [], filter, format));
  parts.push("");
  return parts.join("\n");
}

/** Code-point-safe preview: first 200 + last 200 chars with a length marker. */
function previewOf(content: string): string {
  const chars = Array.from(content);
  if (chars.length <= 400) {
    return chars.join("");
  }
  const first = chars.slice(0, 200).join("");
  const last = chars.slice(-200).join("");
  return `${first}…[${chars.length} chars]…${last}`;
}

/** Strip ANSI/CSI sequences so previews never carry terminal control noise. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;?]*[ -\/]*[@-~]/g, "");
}

function escapeSingleLine(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

/** Walk from dir upward to nearest existing ancestor; check W_OK. */
function checkWritable(dirPath: string): { ok: boolean; note: string } {
  try {
    accessSync(dirPath, fsConstants.W_OK);
    return { ok: true, note: "" };
  } catch {
    return { ok: false, note: `directory not writable: ${dirPath}` };
  }
}

function nearestExistingAncestor(dirPath: string): string | null {
  let cur = pathResolve(dirPath);
  for (;;) {
    if (safeStat(cur)) return cur;
    const parent = pathResolve(cur, "..");
    if (parent === cur) return null;
    cur = parent;
  }
}

export async function runDirExport(
  flags: ExportFlagValues,
  deps: DirExportDeps
): Promise<CliResult> {
  // --- resolve target (alias-scan: try every enabled entry for the agent) ----
  if (!flags.agent || !flags.id) {
    return fail(2, `--dir mode requires --agent <kind> and --id <session-id>.`);
  }
  const candidates = deps.config.agents.filter(
    (e) => e.agent === flags.agent && e.enabled
  );
  if (candidates.length === 0) {
    return fail(3, `No enabled agent "${flags.agent}" in config.`);
  }
  const fetchOpts = flags.withTypes.length > 0 ? { mode: "all_with_tools" } : {};
  let detail: SessionDetail | null = null;
  let query: { agent: string; alias: string; id: string } | null = null;
  for (const cand of candidates) {
    const q = { agent: flags.agent, alias: cand.alias, id: flags.id };
    try {
      const d = await deps.getSession(q, fetchOpts);
      if (d) {
        detail = d;
        query = q;
        break;
      }
    } catch (error) {
      // A throwing alias aborts the scan with context naming it.
      return fail(
        3,
        `${q.agent}:${q.alias}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (!detail || !query) {
    const tried = candidates.map((e) => `${e.agent}:${e.alias}`).join(", ");
    return fail(3, `Session not found under any alias of "${flags.agent}" (tried: ${tried}): ${flags.id}`);
  }

  // --- turns + range -------------------------------------------------------
  const turns = groupTurns(detail.messages ?? []);
  const T = turns.length;
  if (T === 0) {
    return fail(3, `nothing to export: session ${query.id} has no messages.`);
  }
  const rangeResult = resolveRange(
    {
      fromRelative: flags.fromRelative,
      toRelative: flags.toRelative,
      from: flags.fromTurn,
      to: flags.toTurn,
    },
    T
  );
  if (!rangeResult.ok) {
    return fail(2, rangeResult.error);
  }
  const range = rangeResult.value;

  // --- part filter + warnings (pre-slice, full session) --------------------
  const filter: PartFilter = { include: new Set(["text", ...flags.withTypes]) };
  const warnings: string[] = [];
  if (detail.warning) {
    warnings.push(detail.warning);
  }
  const typesPresent = new Set<string>();
  for (const msg of detail.messages ?? []) {
    for (const part of msg.parts) typesPresent.add(part.type);
  }
  if (flags.rawWithFlags.length > 0) {
    const typesFor = (raw: string): string[] => {
      if (raw === "with-tools") return ["tool", "tool_result"];
      if (raw === "with-thinking") return ["reasoning"];
      return [raw.replace(/^with-/, "")];
    };
    for (const raw of flags.rawWithFlags) {
      const types = typesFor(raw);
      if (!types.some((t) => typesPresent.has(t))) {
        warnings.push(
          `--${raw} matched no parts of type ${types.join("/")} (part types present: ${[...typesPresent].sort().join(", ")})`
        );
      }
    }
  }

  // --- dir + prefix --------------------------------------------------------
  const format: ExportFormat = flags.format ?? "markdown";
  const ext = extFor(format);
  const dirRaw = expandTilde(flags.dir ?? ".");
  const dirAbs = pathResolve(dirRaw);
  const stderrLines: string[] = [...warnings.map((w) => `warning: ${w}`)];
  if (flags.dir === "." ) {
    stderrLines.push(`warning: --dir "." exports into the current directory.`);
  }

  // dir safety
  const dirStat = safeStat(dirAbs);
  if (dirStat && !dirStat.isDirectory()) {
    return fail(3, `EEXIST: --dir path is an existing file: ${dirAbs}`);
  }
  if (!dirStat) {
    const ancestor = nearestExistingAncestor(dirAbs);
    const ancStat = ancestor ? safeStat(ancestor) : null;
    if (ancStat && !ancStat.isDirectory()) {
      return fail(
        3,
        `ENOTDIR: parent path is a file, cannot create ${dirAbs} (blocked at ${ancestor})`
      );
    }
  }

  const prefixInput = flags.prefix ?? localDatePrefix();
  const prefixCheck = sanitizePrefix(prefixInput, dirAbs, ext);
  if (typeof prefixCheck !== "string") {
    return fail(2, prefixCheck.error);
  }
  const prefix = prefixCheck;

  // --- build targets -------------------------------------------------------
  const targets: Target[] = [];
  const sliceLen = range.to - range.from + 1;
  const relOf = (absIdx: number) => absIdx - (T - 1);
  const bothBoundsExplicit =
    (flags.fromTurn !== undefined || flags.fromRelative !== undefined) &&
    (flags.toTurn !== undefined || flags.toRelative !== undefined);

  if ((flags.type ?? "split_turn") === "split_turn") {
    for (let abs = range.from; abs <= range.to; abs++) {
      const slice = sliceTurn(detail, turns, { from: abs, to: abs });
      const sliceMeta: SliceMeta = { turn_start: abs, turn_end: abs, total_turns: T };
      const idx = String(abs + 1).padStart(4, "0");
      const path = join(dirAbs, `${prefix}_${idx}.${ext}`);
      targets.push({
        path,
        content: renderSliceContent(slice, detail, filter, format, sliceMeta),
        label: `turn #${abs} (rel ${relOf(abs)})`,
        toolStats: toolCallStats(slice.messages ?? []),
      });
    }
  } else {
    const slice = sliceTurn(detail, turns, range);
    const sliceMeta: SliceMeta = { turn_start: range.from, turn_end: range.to, total_turns: T };
    const suffix = bothBoundsExplicit ? `_${range.from}-${range.to}` : "";
    const path = join(dirAbs, `${prefix}${suffix}.${ext}`);
    const rangedHeader =
      `turns ${range.from + 1}–${range.to + 1} of ${T}` + (bothBoundsExplicit ? "" : " (partial: unbounded end)");
    const header = sliceLen < T ? `turns ${range.from + 1}–${range.to + 1} of ${T}` : undefined;
    targets.push({
      path,
      content: renderSliceContent(slice, detail, filter, format, sliceMeta, header),
      label: `turn #${range.from}–${range.to} (consolidated, ${sliceLen} of ${T} turns)`,
      toolStats: toolCallStats(slice.messages ?? []),
    });
    void rangedHeader;
  }

  // --- dry-run -------------------------------------------------------------
  if (flags.dryRun) {
    const out: string[] = [];
    const totalBytes = targets.reduce((acc, t) => acc + Buffer.byteLength(t.content), 0);
    out.push(`${targets.length} file(s), ${totalBytes} bytes total`);
    if (!dirStat) {
      out.push(`note: --dir does not exist yet — writability/collision checks skipped`);
      const ancestor = nearestExistingAncestor(dirAbs);
      if (ancestor) {
        const w = checkWritable(ancestor);
        if (!w.ok) out.push(`warning: ${w.note} (nearest existing ancestor: ${ancestor})`);
      }
    } else {
      const w = checkWritable(dirAbs);
      if (!w.ok) out.push(`warning: ${w.note}`);
    }
    const withTools = flags.withTypes.includes("tool");
    for (const t of targets) {
      out.push("");
      out.push(t.label);
      out.push(t.path);
      const preview = escapeSingleLine(stripAnsi(previewOf(t.content)));
      out.push(`preview: ${preview}`);
      if (withTools) {
        const total = [...t.toolStats.values()].reduce((a, b) => a + b, 0);
        const breakdown = [...t.toolStats.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, c]) => `${name}:${c}`)
          .join(", ");
        out.push(`tools: ${total}${breakdown ? ` (${breakdown})` : ""}`);
      }
      if (safeStat(t.path)) {
        out.push(`OVERWRITES existing file: ${t.path}`);
      }
    }
    return {
      exitCode: 0,
      stdout: out.join("\n") + "\n",
      stderr: stderrLines.length > 0 ? stderrLines.join("\n") + "\n" : "",
    };
  }

  // --- preflight (real run): stat ALL targets BEFORE any mkdir/write -------
  const refusals: string[] = [];
  const nonRegular: string[] = [];
  const skipWrite = new Set<string>();
  for (const t of targets) {
    const st = safeStat(t.path);
    if (!st) continue;
    if (!st.isFile()) {
      nonRegular.push(t.path);
      continue;
    }
    let existing: string | null = null;
    existing = readTextFile(t.path);
    if (existing === null) {
      // unreadable → treat as differing (refusal) unless --force
      existing = "";
    }
    if (existing === t.content) {
      skipWrite.add(t.path);
      continue;
    }
    if (!flags.force) {
      refusals.push(
        `refusing to overwrite existing file with different content: ${t.path} (use --force)`
      );
    }
  }
  if (nonRegular.length > 0) {
    return fail(
      3,
      `target exists but is not a regular file: ${nonRegular.join(", ")}`
    );
  }
  if (refusals.length > 0) {
    return fail(2, refusals.join("\n"));
  }

  // --- write ---------------------------------------------------------------
  if (!dirStat) {
    try {
      mkdirSync(dirAbs, { recursive: true });
    } catch (error) {
      return fail(
        3,
        `failed to create --dir ${dirAbs}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const sink = createFileSink();
  const written: string[] = [];
  const failed: string[] = [];
  try {
    for (const t of targets) {
      if (skipWrite.has(t.path)) continue;
      const r = await sink.write(t.path, t.content);
      if (r.ok) {
        written.push(t.path);
      } else {
        failed.push(`${t.path}: ${r.error} (${r.phase})`);
      }
    }
  } finally {
    sink.cleanup();
  }
  if (failed.length > 0) {
    return fail(
      3,
      `wrote ${written.length}/${targets.length} files before failure — failed: ${failed.join("; ")}`
    );
  }

  const summary = `exported turns ${range.from + 1}–${range.to + 1} of ${T}`;
  const stdout =
    targets
      .map((t) => (skipWrite.has(t.path) ? `${t.path} (unchanged)` : t.path))
      .join("\n") + "\n";
  return {
    exitCode: 0,
    stdout,
    stderr: [...stderrLines, summary].join("\n") + "\n",
  };
}
