/**
 * src/cmd-usage/classify.ts
 *
 * Shell command classifier — no external dependencies.
 *
 * Pipeline:
 *   1. splitCompound()  — split "a && b | c" into segments
 *   2. tokenize()       — shell-aware tokenizer (quotes, escapes)
 *   3. stripPrefix()    — remove sudo/env/nohup/time/xargs
 *   4. stripEnvAssign() — remove leading FOO=bar assignments
 *   5. basename()       — /usr/bin/git → git
 *   6. buildSignature() — MULTI_VERB dict → "git.diff"
 *   7. normalizeArgs()  — <path>/<hash>/<ref>/<ver> normalization
 *
 * classify() is the pure end-to-end function.
 */

// ── MULTI_VERB whitelist ──────────────────────────────────────────────────

const MULTI_VERB = new Set([
  // git
  "git",
  // build/run
  "npm", "pnpm", "yarn", "bun", "npx", "mise", "cargo", "go", "rustup",
  // infra
  "docker", "kubectl", "nomad", "consul", "helm", "terraform", "ansible",
  // cloud
  "gcloud", "aws",
  // forge
  "gh", "glab",
  // system
  "tmux", "systemctl",
  // agent CLIs
  "pi", "claude", "gemy", "gemini", "ocxo", "opencode", "codex", "ralph", "archon",
]);

// ── tokenize ──────────────────────────────────────────────────────────────

/**
 * Shell-aware tokenizer. Handles:
 * - Double-quoted strings (strips quotes, preserves spaces)
 * - Single-quoted strings (strips quotes, preserves spaces)
 * - Backslash escapes (e.g., \ )
 * - Regular whitespace splitting
 */
export function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let i = 0;

  while (i < cmd.length) {
    const ch = cmd[i];

    if (ch === "\\") {
      // Escaped character — take next char literally
      if (i + 1 < cmd.length) {
        current += cmd[i + 1];
        i += 2;
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      // Double-quoted string
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === "\\" && i + 1 < cmd.length) {
          current += cmd[i + 1];
          i += 2;
        } else {
          current += cmd[i];
          i++;
        }
      }
      if (i < cmd.length) i++; // skip closing "
      continue;
    }

    if (ch === "'") {
      // Single-quoted string
      i++;
      while (i < cmd.length && cmd[i] !== "'") {
        current += cmd[i];
        i++;
      }
      if (i < cmd.length) i++; // skip closing '
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

// ── splitCompound ─────────────────────────────────────────────────────────

/**
 * Split a compound command on shell separators: &&, ||, |, ;
 * Preserves surrounding whitespace in each segment.
 */
export function splitCompound(cmd: string): string[] {
  // Split on && || | ; (in order of precedence — && and || before |)
  const segments = cmd.split(/\s*(?:&&|\|\||[|;])\s*/);
  // The regex above strips surrounding whitespace. But tests expect
  // whitespace preserved: "a && b" → ["a ", " b"]
  // Use a different approach: split keeping whitespace
  return cmd.split(/&&|\|\||(?<!\|)\|(?!\|)|;/);
}

// ── stripPrefix ───────────────────────────────────────────────────────────

const PREFIXES = new Set(["sudo", "env", "nohup", "time", "xargs"]);

/**
 * Strip leading prefix commands: sudo, env, nohup, time, xargs.
 * Loops until no more prefixes found.
 */
export function stripPrefix(tokens: string[]): string[] {
  let result = [...tokens];
  while (result.length > 0 && PREFIXES.has(result[0])) {
    result = result.slice(1);
  }
  return result;
}

// ── stripEnvAssign ────────────────────────────────────────────────────────

const ENV_ASSIGN_RE = /^[A-Z_][A-Z0-9_]*=\S*/;

/**
 * Strip leading environment variable assignments (e.g., FOO=bar).
 * Stops at first non-assignment token.
 */
export function stripEnvAssign(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && ENV_ASSIGN_RE.test(tokens[i])) {
    i++;
  }
  return tokens.slice(i);
}

// ── basename ──────────────────────────────────────────────────────────────

/**
 * Extract basename from a path-like token.
 * /usr/bin/git → git
 * ./scripts/build.sh → build.sh
 * ~/bin/fd → fd
 */
export function basename(token: string): string {
  if (!token) return "";
  const parts = token.split("/");
  // Last non-empty part
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].length > 0) return parts[i];
  }
  return "";
}

// ── buildSignature ────────────────────────────────────────────────────────

export interface SignatureResult {
  sig: string;
  base: string;
  sub?: string;
}

/**
 * Build a signature from cleaned tokens.
 * If base is in MULTI_VERB set, sig = base.sub (if sub is valid).
 * Otherwise sig = base.
 */
export function buildSignature(tokens: string[]): SignatureResult {
  if (tokens.length === 0) {
    return { sig: "", base: "" };
  }

  const base = tokens[0];

  if (!MULTI_VERB.has(base)) {
    return { sig: base, base };
  }

  // MULTI_VERB: check for valid sub-command
  if (tokens.length < 2) {
    return { sig: base, base };
  }

  const candidate = tokens[1];

  // Reject if second token looks like a flag, path, variable, or special
  if (candidate.startsWith("-")) return { sig: base, base };
  if (candidate.startsWith("/")) return { sig: base, base };
  if (candidate.startsWith(".")) return { sig: base, base };
  if (candidate.startsWith("~")) return { sig: base, base };
  if (candidate.startsWith("$")) return { sig: base, base };
  if (candidate.length <= 1) return { sig: base, base };
  if (/^\d+$/.test(candidate)) return { sig: base, base };

  return { sig: `${base}.${candidate}`, base, sub: candidate };
}

// ── normalizeArgs ─────────────────────────────────────────────────────────

const PATH_RE = /^(\/|\.\/|~\/)/;
const HASH_RE = /^[0-9a-f]{7,}$/i;
const VER_RE = /^v?\d+\.\d+/;

export interface NormalizedArgs {
  flags: string[];
  args: string[];
}

/**
 * Separate flags from args, normalize args.
 * Flags: tokens starting with -
 * Args: everything else, normalized:
 *   - paths → <path>
 *   - hex hashes (7+) → <hash>
 *   - version strings → <ver>
 */
export function normalizeArgs(tokens: string[]): NormalizedArgs {
  const flags: string[] = [];
  const args: string[] = [];

  // Skip the first token (command name) — it's not an arg.
  const argTokens = tokens.slice(1);

  for (const tok of argTokens) {
    if (tok.startsWith("-")) {
      flags.push(tok);
    } else {
      if (PATH_RE.test(tok)) {
        args.push("<path>");
      } else if (HASH_RE.test(tok)) {
        args.push("<hash>");
      } else if (VER_RE.test(tok)) {
        args.push("<ver>");
      } else {
        args.push(tok);
      }
    }
  }

  return { flags, args };
}

// ── classify (end-to-end) ─────────────────────────────────────────────────

/**
 * Classify a raw shell command into a CmdMatch.
 * Pure function — no I/O.
 *
 * Pipeline:
 *   1. splitCompound → take first segment
 *   2. tokenize
 *   3. stripPrefix
 *   4. stripEnvAssign
 *   5. basename on first token
 *   6. buildSignature
 */
export function classify(raw: string): { sig: string; base: string; sub?: string; raw: string } {
  if (!raw.trim()) {
    return { sig: "", base: "", raw };
  }

  // 1. Split compound, take first segment
  const segments = splitCompound(raw);
  const first = segments[0].trim();

  if (!first) {
    return { sig: "", base: "", raw };
  }

  // 2. Tokenize
  let tokens = tokenize(first);

  // 3. Strip prefixes
  tokens = stripPrefix(tokens);

  // 4. Strip env assignments
  tokens = stripEnvAssign(tokens);

  if (tokens.length === 0) {
    return { sig: "", base: "", raw };
  }

  // 5. Basename the first token
  tokens[0] = basename(tokens[0]);

  // 6. Build signature
  const result = buildSignature(tokens);

  return { ...result, raw };
}
