/**
 * RED tests for src/skill-usage/parser.ts
 *
 * extractSkillReads(jsonl): extract skill names from assistant toolCall read paths
 *   matching /skills/<name>/SKILL.md
 *
 * extractSkillMentions(jsonl): extract unique lowercase word tokens from text parts
 *   (keeping hyphens/underscores in tokens)
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { extractSkillReads, extractSkillMentions } from "../../src/skill-usage/parser";

const SESSIONS = join(import.meta.dir, "fixtures", "sessions");

describe("extractSkillReads", () => {
  test("extracts skill name from toolCall read path matching /skills/<name>/SKILL.md", () => {
    const file = join(SESSIONS, "session-read-load.jsonl");
    const reads = extractSkillReads(file);
    expect(reads.length).toBe(1);
    expect(reads[0].skill).toBe("verifier-loop");
    expect(reads[0].source).toBe("read-tool");
  });

  test("captures session id and timestamp", () => {
    const file = join(SESSIONS, "session-read-load.jsonl");
    const reads = extractSkillReads(file);
    expect(reads[0].sessionId).toBe("sess-read-load");
    expect(reads[0].timestamp).toBe("2026-07-15T10:00:10.000Z");
  });

  test("returns empty array for session with no read toolCalls", () => {
    const file = join(SESSIONS, "session-alias.jsonl");
    const reads = extractSkillReads(file);
    expect(reads).toEqual([]);
  });

  test("ignores read toolCalls whose path does not match skills/<name>/SKILL.md", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const tmp = await fs.mkdtemp(join(os.tmpdir(), "skill-parser-"));
    const file = join(tmp, "session.jsonl");
    await fs.writeFile(
      file,
      [
        '{"type":"session","version":3,"id":"s1","timestamp":"2026-07-15T10:00:00.000Z","cwd":"/tmp"}',
        '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-15T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"read","arguments":{"path":"/etc/passwd"}}]}}',
      ].join("\n") + "\n",
    );
    const reads = extractSkillReads(file);
    expect(reads).toEqual([]);
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe("extractSkillMentions", () => {
  test("extracts unique lowercase word tokens from assistant text parts", () => {
    const file = join(SESSIONS, "session-text-mention-hyphen.jsonl");
    const tokens = extractSkillMentions(file);
    expect(tokens.length).toBeGreaterThan(0);
    // tokens are unique lowercase words; verify a sample
    const expected = ["verifier", "loop", "yesterday", "verifierloop", "prefer"];
    for (const w of expected) {
      expect(tokens.map((t) => t.token)).toContain(w);
    }
  });

  test("keeps hyphens inside tokens (so 'verifier-loop' survives as single token)", () => {
    const file = join(SESSIONS, "session-text-mention-hyphen.jsonl");
    const tokens = extractSkillMentions(file).map((t) => t.token);
    expect(tokens).toContain("verifier-loop");
  });

  test("captures sessionId and timestamp per token", () => {
    const file = join(SESSIONS, "session-alias.jsonl");
    const tokens = extractSkillMentions(file);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens[0].sessionId).toBe("sess-alias");
    expect(tokens[0].timestamp).toBe("2026-07-15T12:00:10.000Z");
  });

  test("handles multi-line + mixed content types (text + thinking + toolCall)", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const tmp = await fs.mkdtemp(join(os.tmpdir(), "skill-parser-"));
    const file = join(tmp, "session.jsonl");
    await fs.writeFile(
      file,
      [
        '{"type":"session","version":3,"id":"s2","timestamp":"2026-07-15T10:00:00.000Z","cwd":"/tmp"}',
        '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-15T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"internal reasoning about verifier-loop"},{"type":"text","text":"First line.\nSecond line has caveman and verifier-loop."},{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"echo hi"}}]}}',
      ].join("\n") + "\n",
    );
    const tokens = extractSkillMentions(file).map((t) => t.token);
    // text part contributes tokens; thinking part may or may not (impl detail — but at minimum text tokens must appear)
    expect(tokens).toContain("caveman");
    expect(tokens).toContain("verifier-loop");
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("filters tokens shorter than 3 chars", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const tmp = await fs.mkdtemp(join(os.tmpdir(), "skill-parser-"));
    const file = join(tmp, "session.jsonl");
    await fs.writeFile(
      file,
      [
        '{"type":"session","version":3,"id":"s3","timestamp":"2026-07-15T10:00:00.000Z","cwd":"/tmp"}',
        '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-15T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"a ab abc abcd"}]}}',
      ].join("\n") + "\n",
    );
    const tokens = extractSkillMentions(file).map((t) => t.token);
    // length filter: ≥3 — 'a' and 'ab' excluded; 'abc' and 'abcd' included
    expect(tokens).toContain("abc");
    expect(tokens).toContain("abcd");
    expect(tokens).not.toContain("a");
    expect(tokens).not.toContain("ab");
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
