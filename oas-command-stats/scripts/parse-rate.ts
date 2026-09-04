/**
 * Phase 2 contract (a) — measure parse_success rate on REAL cmd samples
 * pulled from local CLI agent sessions, bucketed by complexity (OT43).
 *
 * Targets:
 *   - simple:         >=99%
 *   - medium+complex: >=95%
 *
 * Replaces the original /tmp/cmds_24h.txt (247k cmds) artifact, which was a
 * transient exploration output (turn2 of the findings dir) and is no longer
 * present. This script pulls fresh from whatever local agent sessions exist
 * (pi JSONL, zcode SQLite, hermes SQLite).
 *
 * Usage: bun run scripts/parse-rate.ts
 *
 * @file scripts/parse-rate.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseCommand } from "../src/parse/mvdan";
import { bucketComplexity } from "../src/parse/complexity";

interface Sample {
  cmd: string;
  source: string;
}

/** Pull pi cmds from sessions dir (raw text scan). */
function pullPiCmds(): Sample[] {
  const piDir = join(homedir(), ".pi/agent/sessions");
  if (!existsSync(piDir)) return [];
  const out: Sample[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) walk(p);
      else if (e.endsWith(".jsonl")) {
        try {
          const lines = readFileSync(p, "utf8").split("\n");
          for (const ln of lines) {
            if (!ln.trim()) continue;
            try {
              const j = JSON.parse(ln);
              // pi event shapes: look for bash tool invocations.
              const cmd =
                j?.tool_call?.input?.command ??
                j?.input?.command ??
                j?.args?.command ??
                null;
              if (typeof cmd === "string" && cmd.trim()) {
                out.push({ cmd, source: "pi" });
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }
  };
  walk(piDir);
  return out;
}

/** Pull cmds from zcode db (sqlite). */
async function pullZcodeCmds(): Promise<Sample[]> {
  const zcPath = join(homedir(), ".zcode/cli/db/db.sqlite");
  if (!existsSync(zcPath)) return [];
  try {
    const Database = (await import("bun:sqlite")).default;
    const db = new Database(zcPath, { readonly: true });
    const rows = db.query(
      `SELECT data FROM part WHERE json_extract(data, '$.type') LIKE '%tool%' LIMIT 5000`
    ).all() as { data: string }[];
    const out: Sample[] = [];
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data);
        const cmd =
          d?.input?.command ?? d?.state?.input?.command ?? d?.args?.command;
        if (typeof cmd === "string" && cmd.trim()) {
          out.push({ cmd, source: "zcode" });
        }
      } catch { /* skip */ }
    }
    db.close();
    return out;
  } catch { return []; }
}

/** Pull cmds from hermes db. */
async function pullHermesCmds(): Promise<Sample[]> {
  const hPath = join(homedir(), ".hermes/state.db");
  if (!existsSync(hPath)) return [];
  try {
    const Database = (await import("bun:sqlite")).default;
    const db = new Database(hPath, { readonly: true });
    const rows = db.query(
      `SELECT content FROM messages WHERE content LIKE '%"command"%' LIMIT 5000`
    ).all() as { content: string }[];
    const out: Sample[] = [];
    for (const r of rows) {
      try {
        const c = JSON.parse(r.content);
        const cmd =
          c?.tool_calls?.[0]?.function?.arguments
            ? JSON.parse(c.tool_calls[0].function.arguments).command
            : null;
        if (typeof cmd === "string" && cmd.trim()) {
          out.push({ cmd, source: "hermes" });
        }
      } catch { /* skip */ }
    }
    db.close();
    return out;
  } catch { return []; }
}

async function main() {
  console.error("[parse-rate] pulling samples from local agent sessions...");
  const pi = pullPiCmds();
  const zc = await pullZcodeCmds();
  const he = await pullHermesCmds();
  const samples = [...pi, ...zc, ...he];

  console.error(`[parse-rate] pi=${pi.length} zcode=${zc.length} hermes=${he.length} total=${samples.length}`);

  if (samples.length === 0) {
    console.error("[parse-rate] NO samples found — cannot measure rate.");
    process.exit(2);
  }

  const buckets = { simple: { ok: 0, fail: 0 }, medium: { ok: 0, fail: 0 }, complex: { ok: 0, fail: 0 } };

  for (const s of samples) {
    const b = bucketComplexity(s.cmd);
    const r = await parseCommand(s.cmd);
    if (r.parse_status === "failed") buckets[b].fail++;
    else buckets[b].ok++;
  }

  const fmt = (b: { ok: number; fail: number }) => {
    const total = b.ok + b.fail;
    const rate = total > 0 ? (b.ok / total * 100).toFixed(2) : "n/a";
    return `${rate}% (${b.ok}/${total})`;
  };

  const simpleRate = buckets.simple.ok / Math.max(1, buckets.simple.ok + buckets.simple.fail);
  const mediumComplexOk = buckets.medium.ok + buckets.complex.ok;
  const mediumComplexTotal = mediumComplexOk + buckets.medium.fail + buckets.complex.fail;
  const mcRate = mediumComplexTotal > 0 ? mediumComplexOk / mediumComplexTotal : 0;

  console.log(JSON.stringify({
    total_samples: samples.length,
    by_source: { pi: pi.length, zcode: zc.length, hermes: he.length },
    by_bucket: {
      simple: fmt(buckets.simple),
      medium: fmt(buckets.medium),
      complex: fmt(buckets.complex),
    },
    targets: {
      simple_ge_99pct: simpleRate >= 0.99,
      medium_complex_ge_95pct: mcRate >= 0.95,
    },
  }, null, 2));

  const pass = simpleRate >= 0.99 && mcRate >= 0.95;
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("[parse-rate] fatal:", e);
  process.exit(3);
});
