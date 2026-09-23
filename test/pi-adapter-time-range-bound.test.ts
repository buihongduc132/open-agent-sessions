/**
 * Pi Adapter — bound listSessionsByTimeRange (BHD-160 / BHD-152)
 *
 * Invariant: `--last` / `--limit` must bound bytes read, not only the array
 * returned. Each top-level `*.jsonl` is one session (id = filename uuid).
 * Files with mtime < since − slack must not be opened.
 *
 * Worst-first: cold sibling in the same slug, chmod 000, must not sink the hot session.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createPiAdapter } from "../src/adapters/pi";
import type { Adapter, SessionSummary } from "../src/core/types";

const TMP = join(process.cwd(), ".tmp-pi-time-range-bound-test");

const HOT_ISO = "2024-06-15T12:00:00.000Z";
const HOT_MS = Date.parse(HOT_ISO);
const COLD_ISO = "2020-01-01T00:00:00.000Z";
const COLD_MS = Date.parse(COLD_ISO);

const UUID_HOT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const UUID_HOT_B = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const UUID_HOT_C = "cccccccc-dddd-eeee-ffff-000000000000";
const UUID_COLD = "dddddddd-eeee-ffff-0000-111111111111";
const UUID_OLD_NAME = "eeeeeeee-ffff-0000-1111-222222222222";

const HOT_FILE = `2024-06-15T12-00-00-000Z_${UUID_HOT}.jsonl`;
const HOT_FILE_B = `2024-06-15T13-00-00-000Z_${UUID_HOT_B}.jsonl`;
const HOT_FILE_C = `2024-06-15T14-00-00-000Z_${UUID_HOT_C}.jsonl`;
const COLD_FILE = `2020-01-01T00-00-00-000Z_${UUID_COLD}.jsonl`;
const OLD_NAME_FILE = `2020-01-01T00-00-00-000Z_${UUID_OLD_NAME}.jsonl`;

const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

function makeAdapter(): Adapter {
  return createPiAdapter(
    { agent: "pi", alias: "pi-bound", enabled: true },
    { defaultPath: TMP }
  );
}

function range(since = HOT_MS - EIGHT_HOURS, extra: { limit?: number; skipSessionId?: string; until?: number } = {}) {
  return makeAdapter().listSessionsByTimeRange!({ since, ...extra });
}

function idsOf(result: SessionSummary[]): string[] {
  return result.map((s) => s.id).sort();
}

function seedJsonl(
  slug: string,
  filename: string,
  timestampIso: string,
  userText: string,
  mtimeMs?: number
): string {
  const dir = join(TMP, slug);
  mkdirSync(dir, { recursive: true });
  const uuid =
    filename.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    )?.[0] ?? "sess";
  const sessionLine = {
    type: "session",
    version: 3,
    id: uuid,
    timestamp: timestampIso,
    cwd: "/tmp",
  };
  const msgLine = {
    type: "message",
    id: "m1",
    timestamp: timestampIso,
    message: { role: "user", content: userText },
  };
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(sessionLine) + "\n" + JSON.stringify(msgLine) + "\n");
  if (mtimeMs != null) {
    const atime = new Date(mtimeMs);
    const mtime = new Date(mtimeMs);
    utimesSync(path, atime, mtime);
  }
  return path;
}

function chmodTree(root: string, mode: number): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(root, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        chmodTree(full, mode);
      } else {
        chmodSync(full, mode);
      }
    } catch {
      // ignore — afterEach must still reach rmSync
    }
  }
}

describe("Pi Adapter — listSessionsByTimeRange bounds the jsonl scan (BHD-160)", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    chmodTree(TMP, 0o644);
    rmSync(TMP, { recursive: true, force: true });
  });

  test("does not open a cold jsonl sibling in the same slug as an in-window session", () => {
    const hotPath = seedJsonl("my-project", HOT_FILE, HOT_ISO, "hot session", HOT_MS);
    const coldPath = seedJsonl(
      "my-project",
      COLD_FILE,
      COLD_ISO,
      "COLD_SENTINEL_SHOULD_NOT_BE_PARSED",
      HOT_MS - THIRTY_DAYS
    );
    chmodSync(coldPath, 0o000);

    const result = range();
    expect(idsOf(result)).toContain(UUID_HOT);
    expect(idsOf(result)).not.toContain(UUID_COLD);
    expect(statSync(hotPath).isFile()).toBe(true);
  });

  test("treats each jsonl file as its own session, not the slug directory", () => {
    seedJsonl("my-project", HOT_FILE, HOT_ISO, "first", HOT_MS);
    seedJsonl(
      "my-project",
      HOT_FILE_B,
      "2024-06-15T13:00:00.000Z",
      "second",
      Date.parse("2024-06-15T13:00:00.000Z")
    );

    const result = range();
    const ids = idsOf(result);
    expect(ids).toEqual([UUID_HOT, UUID_HOT_B].sort());
    expect(ids).not.toContain("my-project");
  });

  test("session id comes from filename uuid, not the slug dir name", () => {
    seedJsonl("my-project", HOT_FILE, HOT_ISO, "named", HOT_MS);
    const result = range();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(UUID_HOT);
    expect(result[0].id).not.toBe("my-project");
  });

  test("skips jsonl whose mtime is older than since minus slack without reading them", () => {
    seedJsonl("slug-a", HOT_FILE, HOT_ISO, "hot", HOT_MS);
    const coldPath = seedJsonl(
      "slug-a",
      COLD_FILE,
      COLD_ISO,
      "cold",
      HOT_MS - THIRTY_DAYS
    );
    chmodSync(coldPath, 0o000);

    const result = range(HOT_MS - EIGHT_HOURS);
    expect(idsOf(result)).toEqual([UUID_HOT]);
  });

  test("excludes a file whose mtime is in-window but parsed timestamps are outside the window", () => {
    seedJsonl("slug-stale", COLD_FILE, COLD_ISO, "stale content", HOT_MS);
    const result = range(HOT_MS - EIGHT_HOURS);
    expect(idsOf(result)).not.toContain(UUID_COLD);
    expect(result).toHaveLength(0);
  });

  test("since in the future returns empty and does not read jsonl", () => {
    const coldPath = seedJsonl("slug-future", HOT_FILE, HOT_ISO, "would throw if read", HOT_MS);
    chmodSync(coldPath, 0o000);

    const result = range(Date.now() + 365 * 24 * 60 * 60 * 1000);
    expect(result).toEqual([]);
  });

  test("limit 0 still mtime-prunes by since (does not mean unbounded disk scan)", () => {
    seedJsonl("slug-lim", HOT_FILE, HOT_ISO, "hot", HOT_MS);
    const coldPath = seedJsonl(
      "slug-lim",
      COLD_FILE,
      COLD_ISO,
      "cold",
      HOT_MS - THIRTY_DAYS
    );
    chmodSync(coldPath, 0o000);

    const result = range(HOT_MS - EIGHT_HOURS, { limit: 0 });
    expect(idsOf(result)).toEqual([UUID_HOT]);
  });

  test("empty slug dir yields no sessions", () => {
    mkdirSync(join(TMP, "empty-slug"), { recursive: true });
    const result = range();
    expect(result).toEqual([]);
  });

  test("nested subagent-artifacts jsonl is not merged into the parent session", () => {
    seedJsonl("parent-slug", HOT_FILE, HOT_ISO, "parent hot", HOT_MS);
    const nestedDir = join(TMP, "parent-slug", "subagent-artifacts");
    mkdirSync(nestedDir, { recursive: true });
    const nested = join(nestedDir, COLD_FILE);
    writeFileSync(
      nested,
      JSON.stringify({
        type: "message",
        timestamp: COLD_ISO,
        message: { role: "user", content: "nested-cold" },
      }) + "\n"
    );
    utimesSync(nested, new Date(HOT_MS - THIRTY_DAYS), new Date(HOT_MS - THIRTY_DAYS));
    chmodSync(nested, 0o000);

    const result = range();
    expect(idsOf(result)).toContain(UUID_HOT);
    expect(result).toHaveLength(1);
    expect(result[0].id).not.toBe("parent-slug");
  });

  test("honours limit inside the adapter after sorting by updated_at desc", () => {
    seedJsonl("s", HOT_FILE, HOT_ISO, "A", HOT_MS);
    seedJsonl(
      "s",
      HOT_FILE_B,
      "2024-06-15T13:00:00.000Z",
      "B",
      Date.parse("2024-06-15T13:00:00.000Z")
    );
    seedJsonl(
      "s",
      HOT_FILE_C,
      "2024-06-15T14:00:00.000Z",
      "C",
      Date.parse("2024-06-15T14:00:00.000Z")
    );

    const result = range(HOT_MS - EIGHT_HOURS, { limit: 1 });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(UUID_HOT_C);
  });

  test("honours skipSessionId against the filename uuid", () => {
    seedJsonl("s", HOT_FILE, HOT_ISO, "A", HOT_MS);
    seedJsonl(
      "s",
      HOT_FILE_C,
      "2024-06-15T14:00:00.000Z",
      "C",
      Date.parse("2024-06-15T14:00:00.000Z")
    );

    const result = range(HOT_MS - EIGHT_HOURS, { skipSessionId: UUID_HOT_C });
    expect(idsOf(result)).toEqual([UUID_HOT]);
  });

  test("does not prune on filename timestamp alone (old name, recent mtime still listed)", () => {
    seedJsonl("revived", OLD_NAME_FILE, HOT_ISO, "appended recently", HOT_MS);
    const result = range(HOT_MS - EIGHT_HOURS);
    expect(idsOf(result)).toContain(UUID_OLD_NAME);
  });
});
