/**
 * File sink seam — atomic write, tmp lifecycle.
 * STUB (RED phase): contracts frozen in flow/plans/oas-export-turn-split-design.md.
 */
export type WriteResult =
  | { ok: true; bytes: number }
  | { ok: false; error: string; phase: "tmp-write" | "rename" };

export interface FileSink {
  write(path: string, content: string): Promise<WriteResult>;
  cleanup(): void;
}

export function createFileSink(): FileSink {
  throw new Error("not implemented: createFileSink");
}
