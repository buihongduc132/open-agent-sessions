/**
 * effective_cwd + repo derivation (OT24 rank5, Phase 3).
 *
 * Contract (a)-(f):
 *   (a) effective_cwd from `cd X && cmd` → X (NOT session cwd)
 *   (b) repo = nearest .git parent basename, else basename(cwd)
 *   (c) cross-cwd query groups by repo (via ingest wiring)
 *   (d) subshell/pushd/relative cd tracked via cwd_scope + subshell_cwd
 *   (e) index on repo column (schema.ts)
 *
 * ## Why a hand scanner, not mvdan/sh (CA)
 *
 * sh-syntax@0.6.0 WASM strips AST node fields (see src/parse/mvdan.ts) — only
 * Pos/End survive, so we cannot walk for `cd`/`pushd` nodes. Also parse() is
 * async and deriveEffectiveCwd MUST be sync (called inline in ingest). We
 * therefore run a small quote-aware scanner that recognizes command starts,
 * subshell parens, and statement separators — sufficient for cd/pushd tracking.
 *
 * @file src/parse/cwd.ts
 */
import { resolve, join, isAbsolute, basename, dirname } from "node:path";
import { existsSync } from "node:fs";

export type CwdScope = "session_default" | "explicit_cd" | "pushd_scope";

export interface EffectiveCwd {
  effective_cwd: string | null;
  cwd_scope: CwdScope;
  subshell_cwd: string | null;
}

interface Tok {
  op: boolean;
  value: string;
}

/**
 * Derive the effective working directory a command actually ran in.
 *
 *   - top-level `cd X`      → effective_cwd = resolve(X), scope explicit_cd
 *   - chain `cd X && cd Y`  → last cd wins (resolved cumulatively)
 *   - subshell `(cd X ...)` → subshell_cwd only, outer scope unchanged
 *   - `pushd X`             → subshell_cwd = resolve(X), scope pushd_scope
 *   - no cd                 → effective_cwd = sessionCwd, scope session_default
 */
export function deriveEffectiveCwd(
  cmd: string,
  sessionCwd: string | null,
): EffectiveCwd {
  const tokens = scan(cmd ?? "");

  let current: string | null = sessionCwd;
  let foundTopCd = false;
  let subshellCwd: string | null = null;
  let scope: CwdScope = "session_default";
  let parenDepth = 0;
  let expectCommand = true;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.op) {
      if (t.value === "(") parenDepth++;
      else if (t.value === ")") parenDepth = Math.max(0, parenDepth - 1);
      expectCommand = true;
      continue;
    }

    if (!expectCommand) continue;
    expectCommand = false; // this word is the command name

    const word = t.value;
    if (word === "cd") {
      const target = immediateArg(tokens, i);
      if (target != null) {
        if (parenDepth === 0) {
          current = resolveTarget(target, current);
          foundTopCd = true;
          scope = "explicit_cd";
        } else {
          // Subshell cd — outer scope unchanged, tracked separately.
          subshellCwd = resolveTarget(target, sessionCwd);
        }
      }
    } else if (word === "pushd") {
      const target = immediateArg(tokens, i);
      if (target != null) {
        subshellCwd = resolveTarget(target, sessionCwd);
        scope = "pushd_scope";
      }
    }
  }

  const effective_cwd = foundTopCd ? current : (sessionCwd ?? null);
  return { effective_cwd, cwd_scope: scope, subshell_cwd: subshellCwd };
}

/**
 * Derive repo name from a filesystem path.
 *   1. Walk up looking for a `.git` dir OR file → return that dir's basename.
 *   2. No `.git` up to root → basename(path) fallback.
 * Trailing slashes are stripped before basename.
 */
export function deriveRepo(path: string): string {
  const clean = stripTrailingSlash(path);
  let dir = clean;
  // Bounded walk (defensive) — filesystem depth never approaches this.
  for (let guard = 0; guard < 4096; guard++) {
    if (existsSync(join(dir, ".git"))) {
      return basename(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }
  return basename(clean);
}

// ---------------------------------------------------------------------------

/** Resolve a cd/pushd target against a base dir (tilde + relative + `..`). */
function resolveTarget(target: string, base: string | null): string {
  const home = process.env.HOME ?? "";
  if (target === "~") return home || "~";
  if (target.startsWith("~/")) return join(home, target.slice(2));
  if (isAbsolute(target)) return resolve(target);
  return base ? resolve(base, target) : resolve(target);
}

/** Return the token immediately after i if it is a word, else null. */
function immediateArg(tokens: Tok[], i: number): string | null {
  const next = tokens[i + 1];
  return next && !next.op ? next.value : null;
}

function stripTrailingSlash(p: string): string {
  const s = p.replace(/\/+$/, "");
  return s.length > 0 ? s : "/";
}

/**
 * Quote-aware scanner. Emits word tokens (quotes stripped) plus operator
 * tokens `(`, `)`, `&&`, `||`, `|`, `&`, `;` (newline → `;`).
 */
function scan(s: string): Tok[] {
  const out: Tok[] = [];
  let cur = "";
  let i = 0;
  const flush = () => {
    if (cur.length > 0) {
      out.push({ op: false, value: cur });
      cur = "";
    }
  };

  while (i < s.length) {
    const ch = s[i]!;

    if (ch === "'") {
      i++;
      while (i < s.length && s[i] !== "'") { cur += s[i]; i++; }
      i++;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length) { cur += s[i + 1]; i += 2; }
        else { cur += s[i]; i++; }
      }
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) { cur += s[i + 1]; i += 2; continue; }

    if (ch === " " || ch === "\t") { flush(); i++; continue; }
    if (ch === "\n") { flush(); out.push({ op: true, value: ";" }); i++; continue; }
    if (ch === "(") { flush(); out.push({ op: true, value: "(" }); i++; continue; }
    if (ch === ")") { flush(); out.push({ op: true, value: ")" }); i++; continue; }
    if (ch === ";") { flush(); out.push({ op: true, value: ";" }); i++; continue; }
    if (ch === "&") {
      flush();
      if (s[i + 1] === "&") { out.push({ op: true, value: "&&" }); i += 2; }
      else { out.push({ op: true, value: "&" }); i++; }
      continue;
    }
    if (ch === "|") {
      flush();
      if (s[i + 1] === "|") { out.push({ op: true, value: "||" }); i += 2; }
      else { out.push({ op: true, value: "|" }); i++; }
      continue;
    }

    cur += ch;
    i++;
  }
  flush();
  return out;
}
