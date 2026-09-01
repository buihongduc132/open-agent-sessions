/**
 * RED — file sink tests (oas-export-turn-split).
 * GREEN state: src/core/export-sink.ts implemented.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createFileSink } from "../src/core/export-sink";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oas-sink-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createFileSink", () => {
  test("write ok: content on disk, bytes = Buffer.byteLength, no leftover .tmp", async () => {
    const sink = createFileSink();
    const target = join(dir, "exp_0001.md");
    const content = "hello turn body";
    const r = await sink.write(target, content);
    expect(r).toEqual({ ok: true, bytes: Buffer.byteLength(content) });
    expect(readFileSync(target, "utf-8")).toBe(content);
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  test("atomicity: after write, dir contains ONLY the target file", async () => {
    const sink = createFileSink();
    const target = join(dir, "exp_0002.md");
    await sink.write(target, "x");
    expect(readdirSync(dir).sort()).toEqual(["exp_0002.md"]);
  });

  test("failure to non-existent parent dir: ok:false with phase tmp-write, no partial target", async () => {
    const sink = createFileSink();
    const target = join(dir, "no-such-parent", "exp_0003.md");
    const r = await sink.write(target, "x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.phase).toBe("tmp-write");
      expect(typeof r.error).toBe("string");
      expect(r.error.length).toBeGreaterThan(0);
    }
    expect(existsSync(target)).toBe(false);
  });

  test("cleanup() idempotent, never throws", () => {
    const sink = createFileSink();
    sink.cleanup();
    sink.cleanup();
  });

  test("unicode round-trip byte-exact (emoji + CJK)", async () => {
    const sink = createFileSink();
    const target = join(dir, "exp_0004.md");
    const content = "turn 🤖 会话 body ✓";
    await sink.write(target, content);
    expect(readFileSync(target, "utf-8")).toBe(content);
  });

  test("stale own tmp swept: pre-place {prefix}*.tmp then cleanup removes it", () => {
    const stale = join(dir, "exp_0001.99999.abc.tmp");
    writeFileSync(stale, "stale");
    const sink = createFileSink();
    sink.cleanup();
    // best-effort sweep contract: stale tmp under sink's tracked dir removed
    expect(existsSync(stale)).toBe(false);
  });

  test("write overwrites existing target via atomic rename (collisions handled upstream)", async () => {
    const sink = createFileSink();
    const target = join(dir, "exp_0005.md");
    writeFileSync(target, "OLD");
    const r = await sink.write(target, "NEW");
    expect(r.ok).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("NEW");
  });

  test("subdirectory target supported (mkdir by caller)", async () => {
    const sub = join(dir, "nested");
    mkdirSync(sub);
    const sink = createFileSink();
    const r = await sink.write(join(sub, "exp_0006.md"), "n");
    expect(r.ok).toBe(true);
  });
});

describe("createFileSink — mode preservation (PR45 P1-1)", () => {
  test("overwriting a 0600 file keeps 0600 (never widens under umask)", async () => {
    const sink = createFileSink();
    const target = join(dir, "mode_test.md");
    writeFileSync(target, "OLD", { mode: 0o600 });
    chmodSync(target, 0o600);
    await sink.write(target, "NEW");
    expect((statSync(target).mode & 0o777)).toBe(0o600);
    expect(readFileSync(target, "utf-8")).toBe("NEW");
  });
  test("new files default to 0600", async () => {
    const sink = createFileSink();
    const target = join(dir, "mode_new.md");
    await sink.write(target, "x");
    expect((statSync(target).mode & 0o777)).toBe(0o600);
  });
});
