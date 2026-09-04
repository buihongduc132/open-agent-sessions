/**
 * OT28 / contract (c) — pi event_id = hash(session_file_path + byte_offset_of_record).
 *
 * Byte offset is STABLE on append (existing records keep their byte position).
 * Naive positional index would break on compaction; hash of cmd text collides
 * on repeated identical commands. Byte-offset hash is the correct derivation.
 */
import { describe, it, expect } from "bun:test";
import { derivePiEventId } from "../../src/extract/pi";

describe("pi event_id byte-offset hash (OT28/c)", () => {
  it("same_session_same_offset_same_event_id", () => {
    const id1 = derivePiEventId("/home/x/sess.jsonl", 12345);
    const id2 = derivePiEventId("/home/x/sess.jsonl", 12345);
    expect(id1).toBe(id2);
  });

  it("different_offset_different_event_id", () => {
    const id1 = derivePiEventId("/home/x/sess.jsonl", 100);
    const id2 = derivePiEventId("/home/x/sess.jsonl", 200);
    expect(id1).not.toBe(id2);
  });

  it("different_session_file_different_event_id_same_offset", () => {
    const id1 = derivePiEventId("/home/x/sess-a.jsonl", 100);
    const id2 = derivePiEventId("/home/x/sess-b.jsonl", 100);
    expect(id1).not.toBe(id2);
  });

  it("stable_on_append_old_records_unchanged", () => {
    // Simulate: original file has records at offsets [0, 200, 400].
    // After appending a new record at offset 600, the OLD offsets are unchanged.
    const original = [0, 200, 400].map(off => derivePiEventId("/tmp/s.jsonl", off));
    const appended = [0, 200, 400, 600].map(off => derivePiEventId("/tmp/s.jsonl", off));
    // First 3 unchanged after append.
    expect(appended.slice(0, 3)).toEqual(original);
    // 4th is new.
    expect(appended[3]).not.toBe(original[2]);
  });

  it("event_id_is_hex_hash_not_plain_offset", () => {
    const id = derivePiEventId("/tmp/s.jsonl", 100);
    // Should be a hex digest (sha256 etc.), not "100".
    expect(id).toMatch(/^[a-f0-9]{32,64}$/);
    expect(id).not.toContain("100");
  });
});
