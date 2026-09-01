/**
 * Bin-level CLI tests — oas export (oas-export-turn-split).
 * Spawns the REAL `bun bin/oas export ...` inside temp cwd dirs that carry
 * their own synthetic oas.config.yaml + pi sessions fixture.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/home/bhd/Documents/Projects/bhd/open-agent-sessions/.worktrees/oas-export-turn-split";

let work: string;

function piFixture(root: string, sessDir: string): void {
  const dir = join(root, sessDir);
  mkdirSync(dir, { recursive: true });
  const lines: unknown[] = [
    { type: "message", timestamp: "2026-02-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "first question about exports" }] } },
    { type: "message", timestamp: "2026-02-01T00:00:10Z", message: { role: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "first answer" }] } },
    { type: "message", timestamp: "2026-02-01T00:01:00Z", message: { role: "user", content: [{ type: "text", text: "run the tool please" }] } },
    { type: "message", timestamp: "2026-02-01T00:01:10Z", message: { role: "assistant", content: [{ type: "tool", tool: "bash", state: { phase: "done", output: "tool-output-xyz" } }, { type: "text", text: "second answer" }] } },
    { type: "message", timestamp: "2026-02-01T00:02:00Z", message: { role: "user", content: [{ type: "text", text: "third question" }] } },
    { type: "message", timestamp: "2026-02-01T00:02:10Z", message: { role: "assistant", content: [{ type: "text", text: "third answer" }] } },
  ];
  writeFileSync(join(dir, "sess.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function writeConfig(cwd: string, sessionsRoot: string, extraPi?: { alias: string; path: string }): void {
  const agents = [
    `  - agent: pi\n    alias: pi\n    enabled: true\n    path: ${sessionsRoot}`,
  ];
  if (extraPi) {
    agents.unshift(`  - agent: pi\n    alias: ${extraPi.alias}\n    enabled: true\n    path: ${extraPi.path}`);
  }
  writeFileSync(join(cwd, "oas.config.yaml"), `agents:\n${agents.join("\n")}\n`);
}

interface RunOut { code: number; stdout: string; stderr: string }

async function runOas(cwd: string, args: string[]): Promise<RunOut> {
  const proc = Bun.spawn(["bun", join(REPO, "bin/oas"), ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: process.env.HOME! },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "oas-bin-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("oas export — bin-level CLI", () => {
  test("help: relative-first, contains canonical example, exit 0", async () => {
    const r = await runOas(work, ["export", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--from-relative=-3");
    expect(r.stdout).toContain("--to-relative 0");
    const rel = r.stdout.indexOf("--from-relative");
    const abs = r.stdout.indexOf("--from ");
    expect(rel).toBeGreaterThan(-1);
    if (abs !== -1) expect(rel).toBeLessThan(abs);
  });

  test("unknown flag: exit 2, stderr lists valid flags", async () => {
    const r = await runOas(work, ["export", "--frm", "x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--from|valid/i);
  });

  test("dry-run: exit 0, dir NOT created, per-turn record on stdout", async () => {
    piFixture(work, "sess-a");
    writeConfig(work, work); // root containing sess-a
    const out = join(work, "out");
    const r = await runOas(work, ["export", "--agent", "pi", "--id", "sess-a", "--dir", out, "--dry-run", "--prefix", "p"]);
    expect(r.code).toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(r.stdout).toContain("turn #");
  });

  test("real run: files written, summary line, 3 turns", async () => {
    const root = join(work, "sroot");
    piFixture(root, "sess-b");
    writeConfig(work, root);
    const out = join(work, "out");
    const r = await runOas(work, ["export", "--agent", "pi", "--id", "sess-b", "--dir", out, "--prefix", "p"]);
    expect(r.code).toBe(0);
    const files = readdirSync(out).sort();
    expect(files).toEqual(["p_0001.md", "p_0002.md", "p_0003.md"]);
    expect(r.stderr).toContain("exported turns 1–3 of 3");
  });

  test("relative bounds through real CLI: -1..0 → exactly 2 files", async () => {
    const root = join(work, "sroot");
    piFixture(root, "sess-c");
    writeConfig(work, root);
    const out = join(work, "out");
    const r = await runOas(work, [
      "export", "--agent", "pi", "--id", "sess-c", "--dir", out, "--prefix", "p",
      "--from-relative", "-1", "--to-relative", "0",
    ]);
    expect(r.code).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["p_0002.md", "p_0003.md"]);
  });

  test("--with-tools: tool content lands in export", async () => {
    const root = join(work, "sroot");
    piFixture(root, "sess-d");
    writeConfig(work, root);
    const out = join(work, "out");
    const r = await runOas(work, [
      "export", "--agent", "pi", "--id", "sess-d", "--dir", out, "--prefix", "p", "--with-tools",
    ]);
    expect(r.code).toBe(0);
    const body = await Bun.file(join(out, "p_0002.md")).text();
    expect(body).toContain("bash");
  });

  test("alias-scan: broken first pi alias skipped via null, second resolves", async () => {
    const root = join(work, "sroot");
    piFixture(root, "sess-e");
    const emptyRoot = join(work, "empty");
    mkdirSync(emptyRoot, { recursive: true });
    writeConfig(work, root, { alias: "dead", path: emptyRoot });
    const out = join(work, "out");
    const r = await runOas(work, ["export", "--agent", "pi", "--id", "sess-e", "--dir", out, "--prefix", "p"]);
    // dead alias yields no session (null → scan continues); pi resolves
    expect(r.code).toBe(0);
    expect(existsSync(join(out, "p_0001.md"))).toBe(true);
  });

  test("legacy: no --dir/--output → csf JSON on stdout, exit 0", async () => {
    const root = join(work, "sroot");
    piFixture(root, "sess-f");
    writeConfig(work, root);
    const r = await runOas(work, ["export", "sess-f"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.version).toBe("1.0");
    expect(parsed.source.session_id).toBe("sess-f");
  });
});
