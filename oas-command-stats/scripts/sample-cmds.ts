#!/usr/bin/env bun
/**
 * Sample 247k bash command strings from local pi/zcode/hermes sessions.
 *
 * Used by Phase 2 contract item (a): measure parse_success rate bucketed by
 * complexity (OT43) — ≥95% on medium+complex, ≥99% on simple.
 *
 * Output: /tmp/cmds_24h.txt — one command per line.
 *
 * Strategy (best-effort, no SDK dep at this layer):
 *   - pi: scan ~/.pi/agent/sessions/.../.jsonl, find assistant messages with
 *     bash tool_use calls, extract command string
 *   - zcode: query ~/.zcode/cli/db/db.sqlite tool_usage table for bash tools
 *   - hermes: query ~/.hermes/state.db messages.tool_calls JSON for bash
 *
 * Sampling: stop at 247_000 commands OR all sessions scanned.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Database as SqliteDB } from "bun:sqlite";

const TARGET = 247_000;
const OUT = "/tmp/cmds_24h.txt";

const cmds: string[] = [];

function pushCmd(c: string | undefined | null) {
  if (!c || typeof c !== "string") return;
  const trimmed = c.trim();
  if (!trimmed) return;
  // Strip newlines — one logical command per line in the output file
  cmds.push(trimmed.replace(/\r?\n/g, " ⏎ "));
  if (cmds.length >= TARGET) return false;
  return true;
}

// ─── pi JSONL scan ───────────────────────────────────────────────────────
function scanPi() {
  const dir = join(process.env.HOME ?? "/home/bhd", ".pi/agent/sessions");
  let sessionCount = 0;
  let dirsScanned = 0;
  const MAX_DIRS = 200; // cap work
  try {
    for (const subdir of readdirSync(dir)) {
      if (cmds.length >= TARGET) return;
      const sub = join(dir, subdir);
      let st;
      try { st = statSync(sub); } catch { continue; }
      if (!st.isDirectory()) continue;
      dirsScanned++;
      if (dirsScanned > MAX_DIRS) return;

      for (const f of readdirSync(sub)) {
        if (!f.endsWith(".jsonl")) continue;
        if (cmds.length >= TARGET) return;
        const path = join(sub, f);
        try {
          const txt = readFileSync(path, "utf8");
          for (const line of txt.split("\n")) {
            if (cmds.length >= TARGET) return;
            if (!line.trim()) continue;
            let evt;
            try { evt = JSON.parse(line); } catch { continue; }
            // pi event shapes — assistant message with tool call
            const msg = evt.message ?? evt;
            if (msg?.role !== "assistant") continue;
            const content = msg.content;
            if (!Array.isArray(content)) continue;
            for (const part of content) {
              if (!part || typeof part !== "object") continue;
              // tool_use with bash/shell/pwsh
              if (part.type === "tool_use" || part.input) {
                const name = part.name ?? part.tool ?? "";
                const input = part.input ?? part.state ?? {};
                const isBash = /bash|shell|exec|cmd|powershell/i.test(String(name));
                if (!isBash) continue;
                const c = input.command ?? input.cmd ?? input.script ?? input.input;
                if (pushCmd(c) === false) return;
              }
            }
          }
          sessionCount++;
        } catch { /* skip unreadable */ }
      }
    }
  } catch { /* dir missing */ }
  console.error(`[pi] scanned ${sessionCount} sessions, ${dirsScanned} dirs, total cmds=${cmds.length}`);
}

// ─── zcode SQLite scan ───────────────────────────────────────────────────
function scanZcode() {
  const dbPath = join(process.env.HOME ?? "/home/bhd", ".zcode/cli/db/db.sqlite");
  if (!existsSync(dbPath)) { console.error("[zcode] db missing"); return; }
  try {
    const db = new SqliteDB(dbPath, { readonly: true });
    // Defensive: try common shapes
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[];
    const tnames = tables.map(t => t.name);
    if (!tnames.includes("tool_usage")) { console.error("[zcode] no tool_usage table:", tnames); db.close(); return; }
    const rows = db.query(`
      SELECT tu.input, tu.arguments, tu.args, m.content
      FROM tool_usage tu
      LEFT JOIN message m ON m.id = tu.message_id
      WHERE (tu.tool_name LIKE '%bash%' OR tu.tool_name LIKE '%shell%' OR tu.tool_name LIKE '%exec%'
             OR tu.tool_name LIKE '%cmd%' OR tu.tool_name LIKE '%powershell%')
      LIMIT ${TARGET - cmds.length + 5000}
    `).all() as Record<string, unknown>[];
    for (const r of rows) {
      if (cmds.length >= TARGET) break;
      let c: string | undefined;
      for (const k of ["input", "arguments", "args", "content"]) {
        const v = r[k];
        if (typeof v === "string") {
          try {
            const parsed = JSON.parse(v);
            c = parsed?.command ?? parsed?.cmd ?? parsed?.script ?? parsed?.input;
          } catch { c = v; }
        } else if (v && typeof v === "object") {
          c = (v as any)?.command ?? (v as any)?.cmd ?? (v as any)?.script ?? (v as any)?.input;
        }
        if (c) break;
      }
      if (pushCmd(c) === false) break;
    }
    db.close();
    console.error(`[zcode] total cmds=${cmds.length}`);
  } catch (e) {
    console.error("[zcode] error:", e);
  }
}

// ─── hermes SQLite scan ──────────────────────────────────────────────────
function scanHermes() {
  const dbPath = join(process.env.HOME ?? "/home/bhd", ".hermes/state.db");
  if (!existsSync(dbPath)) { console.error("[hermes] db missing"); return; }
  try {
    const db = new SqliteDB(dbPath, { readonly: true });
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[];
    const tnames = tables.map(t => t.name);
    if (!tnames.includes("messages")) { console.error("[hermes] no messages table:", tnames); db.close(); return; }
    const rows = db.query(`
      SELECT tool_calls FROM messages
      WHERE tool_calls IS NOT NULL AND tool_calls != '[]' AND tool_calls != ''
      LIMIT ${TARGET - cmds.length + 5000}
    `).all() as {tool_calls: string}[];
    for (const r of rows) {
      if (cmds.length >= TARGET) break;
      let calls: any[] = [];
      try { calls = JSON.parse(r.tool_calls); } catch { continue; }
      for (const call of calls) {
        if (cmds.length >= TARGET) break;
        const name = call?.function?.name ?? call?.name ?? call?.tool ?? "";
        if (!/bash|shell|exec|cmd|powershell/i.test(String(name))) continue;
        let args = call?.function?.arguments ?? call?.arguments ?? call?.input ?? {};
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { /* keep as str */ }
        }
        const c = (args as any)?.command ?? (args as any)?.cmd ?? (args as any)?.script ?? (args as any)?.input;
        if (pushCmd(c) === false) break;
      }
    }
    db.close();
    console.error(`[hermes] total cmds=${cmds.length}`);
  } catch (e) {
    console.error("[hermes] error:", e);
  }
}

scanPi();
if (cmds.length < TARGET) scanZcode();
if (cmds.length < TARGET) scanHermes();

// Write output
const out = Bun.file(OUT);
const writer = out.writer();
writer.write(new TextEncoder().encode(cmds.join("\n") + "\n"));
writer.end();

console.error(`\nWrote ${cmds.length} commands to ${OUT}`);
