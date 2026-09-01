/**
 * File sink seam — atomic write (tmp + rename), tmp lifecycle.
 * Contracts: flow/plans/oas-export-turn-split-design.md (frozen before RED).
 */
import { promises as fsp, statSync } from "node:fs";
import {
  existsSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

export type WriteResult =
  | { ok: true; bytes: number }
  | { ok: false; error: string; phase: "tmp-write" | "rename" };

export interface FileSink {
  write(path: string, content: string): Promise<WriteResult>;
  cleanup(): void;
}

/**
 * Tmp file naming convention this sink produces AND sweeps:
 * `<basename>.<pid>.<rand>.tmp` — e.g. `exp_0001.42131.9f8a2c.tmp`.
 */
const TMP_FILE_RE = /\.\d+\.[a-z0-9]+\.tmp$/i;
/**
 * Bounded sweep scope for orphaned scratch dirs this package's tooling/tests
 * create via mkdtemp under the system tmpdir. Anything else under tmpdir is
 * never touched by cleanup().
 */
const TMPDIR_SWEEP_PREFIX = "oas-sink-";

export function createFileSink(): FileSink {
  /** Dirs this sink instance has written to (stale-tmp sweep scope). */
  const touchedDirs = new Set<string>();

  async function write(path: string, content: string): Promise<WriteResult> {
    const dir = dirname(path);
    const tmp = join(dir, `${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);

    // Preserve an existing target's mode on overwrite; default 0600 for new
    // files so exports never widen permissions under a permissive umask.
    let mode = 0o600;
    try {
      const st = statSync(path);
      if (st.isFile()) mode = st.mode & 0o777;
    } catch {
      // target does not exist — keep default
    }

    try {
      const fh = await fsp.open(tmp, "w", mode);
      try {
        await fh.writeFile(content, "utf-8");
      } finally {
        await fh.close();
      }
    } catch (error) {
      safeUnlink(tmp);
      return {
        ok: false,
        error: `tmp-write failed for ${path}: ${errorMessage(error)}`,
        phase: "tmp-write",
      };
    }

    try {
      await fsp.rename(tmp, path);
    } catch (error) {
      safeUnlink(tmp);
      return {
        ok: false,
        error: `rename failed for ${path}: ${errorMessage(error)}`,
        phase: "rename",
      };
    }

    touchedDirs.add(dir);
    return { ok: true, bytes: Buffer.byteLength(content) };
  }

  function cleanup(): void {
    const dirs = new Set(touchedDirs);
    try {
      for (const entry of readdirSync(tmpdir())) {
        if (entry.startsWith(TMPDIR_SWEEP_PREFIX)) {
          dirs.add(join(tmpdir(), entry));
        }
      }
    } catch {
      // tmpdir unreadable — nothing to sweep there.
    }
    for (const dir of dirs) {
      sweepDir(dir);
    }
  }

  return { write, cleanup };
}

/** Remove stale tmp files matching the sink naming convention in one directory. */
function sweepDir(dir: string): void {
  try {
    for (const entry of readdirSync(dir)) {
      if (TMP_FILE_RE.test(entry)) {
        safeUnlink(join(dir, entry));
      }
    }
  } catch {
    // Directory gone or unreadable — sweep is best-effort and must never throw.
  }
}

function safeUnlink(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best-effort cleanup — never surface.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
