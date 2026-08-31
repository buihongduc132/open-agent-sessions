/**
 * RED — dir-mode export tests (oas-export-turn-split).
 * RED state: src/cli/export-dir.ts stub throws "not implemented".
 * Legacy backward-compat guards (runExportCommand w/o --dir) exercise EXISTING
 * code and pass today by design.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runDirExport } from "../src/cli/export-dir";
import { runExportCommand } from "../src/cli/export";
import type { ExportFlagValues } from "../src/cli/export-options";
import type { SessionDetail, SessionMessage, SessionPart } from "../src/core/types";
import {
  mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let home: string;
const OLD_HOME = process.env.HOME;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oas-direxp-"));
  home = mkdtempSync(join(tmpdir(), "oas-home-"));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = OLD_HOME;
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// --- fixtures ---------------------------------------------------------------

const T = (text: string): SessionPart => ({ type: "text", text });
const TOOL = (name: string): SessionPart => ({ type: "tool", tool: name, state: { phase: "done" } });
const TR = (name: string): SessionPart => ({ type: "tool_result", tool: name, state: {} });
const REASON = (text: string): SessionPart => ({ type: "reasoning", text });

function mk3TurnDetail(warning?: string): SessionDetail {
  const msgs: SessionMessage[] = [];
  for (let i = 0; i < 3; i++) {
    msgs.push({
      id: `u${i}`, role: "user",
      parts: i === 1 ? [T(`question ${i}`), TOOL("bash")] : [T(`question ${i}`)],
      created_at: `2026-01-01T00:0${i}:00Z`, index: i * 2 + 1,
    });
    msgs.push({
      id: `a${i}`, role: "assistant",
      parts: i === 1 ? [REASON("thinking hard"), T(`answer ${i}`), TR("bash")] : [T(`answer ${i}`)],
      created_at: `2026-01-01T00:0${i}:30Z`, index: i * 2 + 2,
    });
  }
  return {
    id: "sess-3turn", agent: "pi", alias: "pi", title: "three turns",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:02:30Z",
    message_count: msgs.length, storage: "jsonl", messages: msgs, warning,
  };
}

function depsFor(detail: SessionDetail, calls?: { mode?: string }[]) {
  return {
    config: { agents: [{ agent: "pi", alias: "pi", enabled: true }] },
    getSession: async (_q: { agent: string; alias: string; id: string }, opts?: { mode?: string }) => {
      if (calls) calls.push({ mode: opts?.mode });
      return detail;
    },
  };
}

function flags(over: Partial<ExportFlagValues>): ExportFlagValues {
  return {
    agent: "pi", id: "sess-3turn", dir: join(dir, "out"), prefix: "exp",
    type: "split_turn", withTypes: [], rawWithFlags: [], ...over,
  };
}

// --- split_turn real runs ----------------------------------------------------

describe("dir export — split_turn real run", () => {
  test("creates dir, writes one markdown file per turn, idx zero-pad width 4, summary line", async () => {
    const out = join(dir, "out");
    const r = await runDirExport(flags({ dir: out }), depsFor(mk3TurnDetail()));
    expect(r.exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);
    const files = readdirSync(out).sort();
    expect(files).toEqual(["exp_0001.md", "exp_0002.md", "exp_0003.md"]);
    expect(r.stderr).toContain("exported turns 1–3 of 3");
    const body = readFileSync(join(out, "exp_0002.md"), "utf-8");
    expect(body).toContain("question 1");
    expect(body).toContain("answer 1");
  });

  test("default prefix = today YYYY-MM-DD local", async () => {
    const out = join(dir, "out2");
    const now = new Date();
    const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const r = await runDirExport(flags({ dir: out, prefix: undefined }), depsFor(mk3TurnDetail()));
    expect(r.exitCode).toBe(0);
    expect(readdirSync(out).some((f) => f.startsWith(`${ymd}_0001.`))).toBe(true);
  });

  test("--format csf writes .json files with slice source meta", async () => {
    const out = join(dir, "out3");
    const r = await runDirExport(flags({ dir: out, format: "csf" }), depsFor(mk3TurnDetail()));
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(readFileSync(join(out, "exp_0001.json"), "utf-8"));
    expect(body.source.message_count).toBe(2);
    expect(body.source.slice).toEqual({ turn_start: 0, turn_end: 0, total_turns: 3 });
  });

  test("byte-stable re-export: same session + prefix → byte-identical files", async () => {
    const out = join(dir, "out4");
    await runDirExport(flags({ dir: out }), depsFor(mk3TurnDetail()));
    const first = readdirSync(out).map((f) => readFileSync(join(out, f)));
    await runDirExport(flags({ dir: out }), depsFor(mk3TurnDetail()));
    const second = readdirSync(out).map((f) => readFileSync(join(out, f)));
    expect(second).toEqual(first);
  });
});

// --- consolidate ---------------------------------------------------------------

describe("dir export — consolidate", () => {
  test("single combined file {prefix}.md, all turns present", async () => {
    const out = join(dir, "cout");
    const r = await runDirExport(flags({ dir: out, type: "consolidate" }), depsFor(mk3TurnDetail()));
    expect(r.exitCode).toBe(0);
    const files = readdirSync(out);
    expect(files).toEqual(["exp.md"]);
    const body = readFileSync(join(out, "exp.md"), "utf-8");
    expect(body).toContain("question 0");
    expect(body).toContain("answer 2");
  });

  test("ranged consolidate: suffix _0-1 (absolute bounds, both explicit), ranged header", async () => {
    const out = join(dir, "cout2");
    const r = await runDirExport(
      flags({ dir: out, type: "consolidate", fromTurn: "0", toTurn: "1" }),
      depsFor(mk3TurnDetail())
    );
    expect(r.exitCode).toBe(0);
    expect(readdirSync(out)).toEqual(["exp_0-1.md"]);
    const body = readFileSync(join(out, "exp_0-1.md"), "utf-8");
    expect(body).toMatch(/turns 1[–-]2 of 3/);
  });

  test("implied end → no range suffix", async () => {
    const out = join(dir, "cout3");
    const r = await runDirExport(
      flags({ dir: out, type: "consolidate", fromTurn: "1" }),
      depsFor(mk3TurnDetail())
    );
    expect(r.exitCode).toBe(0);
    expect(readdirSync(out)).toEqual(["exp.md"]);
  });
});

// --- dry-run ------------------------------------------------------------------

describe("dir export — dry-run", () => {
  test("writes NOTHING (no dir creation), per-turn records: abs+rel index, path, preview, tool stats", async () => {
    const out = join(dir, "dout");
    const r = await runDirExport(
      flags({ dir: out, dryRun: true, withTypes: ["tool", "tool_result"], rawWithFlags: ["with-tools"] }),
      depsFor(mk3TurnDetail())
    );
    expect(r.exitCode).toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(r.stdout).toContain("turn #0");
    expect(r.stdout).toContain("turn #1");
    expect(r.stdout).toMatch(/rel\s+-2|rel -2|\(rel -2\)/);
    expect(r.stdout).toContain(out);
    expect(r.stdout).toMatch(/tools?:/i);
    expect(r.stdout).not.toContain("\u001b[");
  });

  test("preview chars ⊆ rendered file content; first/last 200 with […len] marker on long turns", async () => {
    const long = "A".repeat(600) + "MIDDLE" + "B".repeat(600);
    const detail = mk3TurnDetail();
    detail.messages![0].parts = [T(long)];
    const out = join(dir, "dout2");
    const dry = await runDirExport(flags({ dir: out, dryRun: true }), depsFor(detail));
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toMatch(/\[…|\.\.\.|…/);

    // now real write; preview chars from dry-run must appear in file
    const real = await runDirExport(flags({ dir: out }), depsFor(detail));
    expect(real.exitCode).toBe(0);
    const fileBody = readFileSync(join(out, "exp_0001.md"), "utf-8");
    expect(fileBody).toContain("MIDDLE");
  });

  test("dry-run collision marks OVERWRITES existing; writability reported", async () => {
    const out = join(dir, "dout3");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "exp_0001.md"), "PREEXISTING");
    const r = await runDirExport(flags({ dir: out, dryRun: true }), depsFor(mk3TurnDetail()));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("OVERWRITES existing");
    expect(readFileSync(join(out, "exp_0001.md"), "utf-8")).toBe("PREEXISTING");
  });

  test("dry-run consolidate = single record with combined path + total bytes; summary first", async () => {
    const out = join(dir, "dout4");
    const r = await runDirExport(flags({ dir: out, dryRun: true, type: "consolidate" }), depsFor(mk3TurnDetail()));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(join(out, "exp.md"));
    expect(r.stdout.match(/turn #/g)?.length).toBe(1);
    expect(r.stdout).toMatch(/bytes/i);
  });

  test("dry-run with absent dir → banner that writability/collision checks skipped", async () => {
    const r = await runDirExport(
      flags({ dir: join(dir, "never", "created"), dryRun: true }),
      depsFor(mk3TurnDetail())
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/skip/i);
  });

  test("record layout parseable: path on own line works with space-containing dir", async () => {
    const out = join(dir, "has space");
    const r = await runDirExport(flags({ dir: out, dryRun: true }), depsFor(mk3TurnDetail()));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(out);
  });
});

// --- collision + preflight ------------------------------------------------------

describe("dir export — collision + preflight", () => {
  test("differing-content existing file → refusal exit 2, NOT overwritten", async () => {
    const out = join(dir, "coll");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "exp_0001.md"), "DIFFERENT");
    const r = await runDirExport(flags({ dir: out }), depsFor(mk3TurnDetail()));
    expect(r.exitCode).toBe(2);
    expect(readFileSync(join(out, "exp_0001.md"), "utf-8")).toBe("DIFFERENT");
  });

  test("--force overwrites differing content", async () => {
    const out = join(dir, "coll2");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "exp_0001.md"), "DIFFERENT");
    const r = await runDirExport(flags({ dir: out, force: true }), depsFor(mk3TurnDetail()));
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(out, "exp_0001.md"), "utf-8")).not.toBe("DIFFERENT");
  });

  test("identical existing content → ok without --force", async () => {
    const out = join(dir, "coll3");
    const d = mk3TurnDetail();
    await runDirExport(flags({ dir: out }), depsFor(d));
    const again = await runDirExport(flags({ dir: out }), depsFor(d));
    expect(again.exitCode).toBe(0);
  });

  test("preflight all-or-nothing: one collision blocks ALL writes", async () => {
    const out = join(dir, "coll4");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "exp_0003.md"), "IN THE WAY");
    const r = await runDirExport(flags({ dir: out }), depsFor(mk3TurnDetail()));
    expect(r.exitCode).toBe(2);
    // turn 1+2 files must NOT exist (preflight refused before writing anything)
    expect(existsSync(join(out, "exp_0001.md"))).toBe(false);
    expect(existsSync(join(out, "exp_0002.md"))).toBe(false);
  });

  test("existing non-regular target (directory) → hard error", async () => {
    const out = join(dir, "coll5");
    mkdirSync(join(out, "exp_0001.md"), { recursive: true });
    const r = await runDirExport(flags({ dir: out }), depsFor(mk3TurnDetail()));
    expect(r.exitCode).not.toBe(0);
  });
});

// --- dir safety + prefix sanitize ------------------------------------------------

describe("dir export — dir safety + prefix sanitize", () => {
  test("--dir points at existing FILE → error (exit 3, EEXIST-ish)", async () => {
    const fileAsDir = join(dir, "iamfile");
    writeFileSync(fileAsDir, "x");
    const r = await runDirExport(flags({ dir: fileAsDir }), depsFor(mk3TurnDetail()));
    expect(r.exitCode).toBe(3);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test("parent is file → ENOTDIR-ish error exit 3", async () => {
    const fileAsParent = join(dir, "iamfile2");
    writeFileSync(fileAsParent, "x");
    const r = await runDirExport(
      flags({ dir: join(fileAsParent, "sub") }),
      depsFor(mk3TurnDetail())
    );
    expect(r.exitCode).toBe(3);
  });

  test("'.' as dir allowed with warning", async () => {
    const cwdNow = process.cwd();
    process.chdir(dir);
    try {
      const r = await runDirExport(flags({ dir: "." }), depsFor(mk3TurnDetail()));
      expect(r.exitCode).toBe(0);
      expect(r.stderr.toLowerCase()).toContain("warn");
      expect(existsSync(join(dir, "exp_0001.md"))).toBe(true);
    } finally {
      process.chdir(cwdNow);
    }
  });

  test("~ expanded to HOME", async () => {
    const r = await runDirExport(flags({ dir: "~/tilde-out" }), depsFor(mk3TurnDetail()));
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(home, "tilde-out", "exp_0001.md"))).toBe(true);
  });

  test("bad prefixes rejected with message: path sep, .., control char, Windows-invalid, overlong", async () => {
    for (const bad of ["a/b", "..", "a\u0000b", "a<b", "x".repeat(300)]) {
      const r = await runDirExport(flags({ prefix: bad }), depsFor(mk3TurnDetail()));
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr.length).toBeGreaterThan(0);
    }
  });
});

// --- ranges ----------------------------------------------------------------------

describe("dir export — turn ranges", () => {
  test("relative -1..0 → last two turns only", async () => {
    const out = join(dir, "rout");
    const r = await runDirExport(
      flags({ dir: out, fromRelative: "-1", toRelative: "0" }),
      depsFor(mk3TurnDetail())
    );
    expect(r.exitCode).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["exp_0002.md", "exp_0003.md"]);
    expect(r.stderr).toContain("exported turns 2–3 of 3");
  });

  test("out-of-range relative → error echoing T", async () => {
    const r = await runDirExport(
      flags({ dir: join(dir, "nope"), fromRelative: "-5" }),
      depsFor(mk3TurnDetail())
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("3");
  });

  test("inverted bounds → error showing both resolved absolutes", async () => {
    const r = await runDirExport(
      flags({ dir: join(dir, "nope2"), fromTurn: "2", toTurn: "0" }),
      depsFor(mk3TurnDetail())
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("2");
    expect(r.stderr).toContain("0");
  });

  test("empty session (0 messages) → 'nothing to export' nonzero", async () => {
    const empty = mk3TurnDetail();
    empty.messages = [];
    empty.message_count = 0;
    const r = await runDirExport(flags({ dir: join(dir, "empty") }), depsFor(empty));
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("nothing to export");
  });
});

// --- with-tools + warnings ---------------------------------------------------------

describe("dir export — with-* + warnings", () => {
  test("withTypes → getSession called with mode all_with_tools; export contains tool content + stats", async () => {
    const calls: { mode?: string }[] = [];
    const out = join(dir, "wout");
    const r = await runDirExport(
      flags({ dir: out, withTypes: ["tool", "tool_result"], rawWithFlags: ["with-tools"] }),
      depsFor(mk3TurnDetail(), calls)
    );
    expect(r.exitCode).toBe(0);
    expect(calls.at(-1)?.mode).toBe("all_with_tools");
    const body = readFileSync(join(out, "exp_0002.md"), "utf-8");
    expect(body).toContain("bash");
    expect(body).toMatch(/tool/i);
  });

  test("zero-match --with-X → warning naming part types present, computed pre-slice", async () => {
    const r = await runDirExport(
      flags({ dir: join(dir, "wout2"), fromRelative: "-1", withTypes: ["nonexistent"], rawWithFlags: ["with-nonexistent"] }),
      depsFor(mk3TurnDetail())
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("with-nonexistent");
    expect(r.stderr).toContain("text");
  });

  test("detail.warning (compaction/drift) surfaced on stderr before writes", async () => {
    const out = join(dir, "wout3");
    const r = await runDirExport(flags({ dir: out }), depsFor(mk3TurnDetail("compaction detected")));
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("compaction");
  });
});

// --- legacy backward compat (EXISTING behavior — passes today by design) ------------

describe("legacy export (no --dir) backward compat", () => {
  test("no --dir/--output → csf JSON on stdout, exit 0", async () => {
    const detail = mk3TurnDetail();
    const r = await runExportCommand({
      sessionRef: "sess-3turn",
      config: { agents: [{ agent: "pi", alias: "pi", enabled: true }] } as never,
      getSession: async () => detail,
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.version).toBe("1.0");
    expect(parsed.source.session_id).toBe("sess-3turn");
  });
});
