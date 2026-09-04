/**
 * mvdan/sh v3 WASM parser wrapper (sh-syntax npm).
 *
 * Resolves OT20 (rank5): quote-aware AST parsing — replaces naive
 * .split('|') / split(/\s+/) which break on quoted pipes, ANSI-C quoting,
 * escaped vars, quoted spaces.
 *
 * ## Known limitation (CA1 — document in plan)
 *
 * sh-syntax@0.6.0's WASM output strips AST node-specific fields (Args, Op,
 * etc.) during JSON marshaling — only Pos/End positions survive. We therefore
 * use mvdan/sh for TWO purposes:
 *   1. SYNTAX VALIDATION: parse() throws on invalid shell syntax → poison row
 *      detection. This is the load-bearing OT20 feature (a regex-based parser
 *      would silently accept broken syntax AND mis-split quoted pipes).
 *   2. STRUCTURAL NORMALIZATION: print() reformats the AST → normalized
 *      whitespace + token boundaries. We then run a careful quote-aware
 *      tokenizer over the normalized form to extract program/flags/args.
 *
 * The tokenizer is NOT a substitute for mvdan/sh — it only runs AFTER mvdan/sh
 * has validated + normalized. Quote-awareness comes from mvdan/sh's parse
 * step (which respects quotes when building the AST). The tokenizer respects
 * the normalized boundaries mvdan/sh produced.
 *
 * @file src/parse/mvdan.ts
 */
import { parse as shParse, print as shPrint } from "sh-syntax";
import type { ParsedCommand, ParseStatus } from "../types/contract";

const SH_SYNTAX_VERSION = "sh-syntax@0.6.0";

/** Lazy-cached parser version (contract test reads this). */
export async function getParserVersion(): Promise<string> {
  return SH_SYNTAX_VERSION;
}

/**
 * Parse a shell command via mvdan/sh WASM and extract structured fields.
 *
 * Steps:
 *   1. parse() — throws on invalid syntax → parse_status='failed'
 *   2. print() — normalize AST → whitespace + token boundaries preserved
 *   3. tokenize normalized form → program, subcommand, args, flags
 *   4. count pipes/&&/||/; by scanning normalized form OUTSIDE quotes
 */
export async function parseCommand(cmd: string): Promise<ParsedCommand> {
  if (!cmd || !cmd.trim()) {
    return {
      program: null, subcommand: null, positional_args: [], flags: [],
      pipeline_depth: 0, statement_count: 0,
      parse_status: "ok", parser_notes: "empty_or_whitespace_only",
    };
  }

  let ast: any;
  try {
    ast = await shParse(cmd);
  } catch (err: any) {
    return {
      program: null, subcommand: null, positional_args: [], flags: [],
      pipeline_depth: 0, statement_count: 0,
      parse_status: "failed",
      parser_notes: `parse_error: ${err?.message?.slice(0, 200) ?? "unknown"}`,
    };
  }

  // Normalize via print() — respects quotes when re-emitting tokens.
  let normalized: string;
  try {
    normalized = await shPrint(ast, { originalText: cmd });
  } catch (err: any) {
    return {
      program: null, subcommand: null, positional_args: [], flags: [],
      pipeline_depth: 0, statement_count: 0,
      parse_status: "failed",
      parser_notes: `print_error: ${err?.message?.slice(0, 200) ?? "unknown"}`,
    };
  }

  return extractFromNormalized(cmd, normalized, ast);
}

interface WalkResult {
  program: string | null;
  subcommand: string | null;
  positional_args: string[];
  flags: string[];
  pipeline_depth: number;
  statement_count: number;
  parse_status: ParseStatus;
  parser_notes: string | null;
}

function extractFromNormalized(original: string, normalized: string, ast: any): ParsedCommand {
  const result: WalkResult = {
    program: null, subcommand: null,
    positional_args: [], flags: [],
    pipeline_depth: 0, statement_count: 0,
    parse_status: "ok", parser_notes: null,
  };

  const stmts: any[] = ast?.Stmts ?? [];
  result.statement_count = stmts.length || 0;
  if (stmts.length === 0) return result;

  // Tokenize normalized form — quote-aware.
  const tokens = tokenize(normalized);

  // First statement: program + flags + args.
  // Subsequent pipeline segments: also collect their flags.
  const allFlags: string[] = [];
  const allArgs: string[] = [];
  let firstProgram: string | null = null;
  let firstArgs: string[] = [];
  let firstFlags: string[] = [];
  let firstSet = false;

  // Split tokens by pipe (top-level only — tokenizer already handled quotes).
  const pipeSegments = splitOnTopLevelPipes(tokens);
  result.pipeline_depth = pipeSegments.length;

  // Split by && / || / ; / \n for statement_count (more accurate than Stmts
  // length — counts individual commands). mvdan print() normalizes ; → \n.
  result.statement_count = countLogicalCommands(normalized) || result.statement_count;

  for (const segTokens of pipeSegments) {
    const segFlags: string[] = [];
    const segArgs: string[] = [];
    let segProgram: string | null = null;
    for (const tok of segTokens) {
      if (tok.startsWith("--")) {
        segFlags.push(tok);
      } else if (/^-[a-zA-Z0-9]+$/.test(tok) && tok !== "-") {
        // Expand combined short flags: -rnE → -r -n -E (OT5-G1)
        for (const ch of tok.slice(1)) segFlags.push(`-${ch}`);
      } else if (tok.startsWith("-")) {
        segFlags.push(tok);
      } else {
        if (segProgram === null) segProgram = tok;
        else segArgs.push(tok);
      }
    }
    if (!firstSet && segProgram) {
      firstProgram = segProgram;
      firstArgs = segArgs;
      firstFlags = segFlags;
      firstSet = true;
    } else {
      allFlags.push(...segFlags);
      allArgs.push(...segArgs);
    }
  }

  result.program = firstProgram;
  // Subcommand = first non-flag positional after program, but ONLY for
  // programs known to use subcommand syntax (git commit, npm install, etc.).
  // For echo, cat, ls, etc., the first positional is a real argument.
  const SUBCOMMAND_PROGRAMS = new Set([
    "git", "npm", "yarn", "pnpm", "bun", "docker", "kubectl", "helm",
    "cargo", "rustup", "go", "python", "python3", "pip", "poetry",
    "terraform", "ansible", "vagrant", "aws", "gcloud", "az",
    "gh", "jq", "sed", "awk",
  ]);
  if (
    firstArgs.length > 0 &&
    !(firstArgs[0] ?? "").startsWith("-") &&
    firstProgram &&
    SUBCOMMAND_PROGRAMS.has(firstProgram)
  ) {
    result.subcommand = firstArgs[0] !== undefined ? firstArgs[0] : null;
    result.positional_args = firstArgs.slice(1);
  } else {
    result.positional_args = firstArgs;
  }
  result.flags = dedupe([...firstFlags, ...allFlags]);

  // Partial detection: control chars or suspicious patterns in args
  const notes: string[] = [];
  const argStr = [...firstArgs, ...allArgs].join(" ");
  if (/[\x00-\x08\x0E-\x1F]/.test(argStr)) notes.push("control_char_in_args");
  if (/\$\x01/.test(original) || /\\x[0-9a-f]{2}/.test(original)) {
    notes.push("binary_in_args");
  }
  if (notes.length > 0) {
    result.parse_status = "partial";
    result.parser_notes = notes.join(",");
  }

  return result;
}

/**
 * Quote-aware tokenizer. Respects single quotes, double quotes, ANSI-C
 * quoting ($'...'), and backslash escapes.
 *
 * Returns tokens with quote characters REMOVED (so "hello world" becomes one
 * token "hello world"). This is the OT20-correct behavior.
 */
function tokenize(s: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let i = 0;
  let inWord = false;
  let hasContent = false; // track if current has non-whitespace content

  while (i < s.length) {
    const ch = s[i];

    // Whitespace outside quotes → token boundary
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (inWord && hasContent) {
        tokens.push(current);
        current = "";
        inWord = false;
        hasContent = false;
      } else if (inWord) {
        // whitespace inside word continuation — ignore
      }
      i++;
      continue;
    }

    inWord = true;

    // Line continuation: backslash + newline → join
    if (ch === "\\" && s[i + 1] === "\n") {
      i += 2;
      continue;
    }

    // ANSI-C quoting: $'...' — preserve content literally (with escapes)
    if (ch === "$" && (s[i + 1] ?? "") === "'") {
      i += 2;
      let escaped = "";
      while (i < s.length && s[i] !== "'") {
        if (s[i] === "\\" && i + 1 < s.length) {
          escaped += (s[i] ?? "") + (s[i + 1] ?? "");
          i += 2;
        } else {
          escaped += s[i] ?? "";
          i++;
        }
      }
      i++; // closing '
      current += `$'${escaped}'`;
      hasContent = true;
      continue;
    }

    // Single quote: literal until next '
    if (ch === "'") {
      i++;
      let quoted = "";
      while (i < s.length && s[i] !== "'") {
        quoted += s[i];
        i++;
      }
      i++; // closing '
      current += quoted;
      hasContent = true;
      continue;
    }

    // Double quote: respect backslash escapes, $ expansions
    if (ch === '"') {
      i++;
      let quoted = "";
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length) {
          // Inside double quotes, backslash only escapes $ ` " \ newline
          const next = s[i + 1] ?? "";
          if (next === "$" || next === "`" || next === '"' || next === "\\" || next === "\n") {
            quoted += next;
            i += 2;
          } else {
            quoted += (s[i] ?? "") + next;
            i += 2;
          }
        } else {
          quoted += s[i] ?? "";
          i++;
        }
      }
      i++; // closing "
      current += quoted;
      hasContent = true;
      continue;
    }

    // Backslash escape outside quotes
    if (ch === "\\" && i + 1 < s.length) {
      current += s[i + 1];
      hasContent = true;
      i += 2;
      continue;
    }

    // Regular char
    current += ch;
    hasContent = true;
    i++;
  }

  if (inWord && hasContent) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Split tokens into pipeline segments on top-level | (not ||).
 * The tokenizer already handled quoted pipes, so any | token here is a real pipe.
 */
function splitOnTopLevelPipes(tokens: string[]): string[][] {
  const segments: string[][] = [[]];
  for (const tok of tokens) {
    if (tok === "|") {
      segments.push([]);
    } else if (tok === "||") {
      // || is a statement separator, not a pipe — start new statement+pipeline
      segments.push([]);
    } else {
      (segments[segments.length - 1] ??= []).push(tok);
    }
  }
  return segments.filter(s => s.length > 0);
}

/**
 * Count logical commands separated by && / || / ; / \n at top level.
 *
 * Note: mvdan/sh `print()` normalizes `;` to `\n`, so this scanner must
 * treat `\n` as a statement separator (not just && / || / ;). Each segment
 * between separators counts as 1 command.
 */
function countLogicalCommands(normalized: string): number {
  let count = 0;
  let i = 0;
  let inSingle = false, inDouble = false, inDollar = false;
  let hasContentSinceSep = false;

  while (i < normalized.length) {
    const ch = normalized[i] ?? "";
    const next = normalized[i + 1] ?? "";

    if (!inDouble && !inDollar && ch === "'") { inSingle = !inSingle; i++; continue; }
    if (!inSingle && !inDollar && ch === '"') { inDouble = !inDouble; i++; continue; }
    if (!inSingle && !inDouble && ch === "$" && next === "'") { inDollar = !inDollar; i += 2; continue; }

    if (inSingle || inDouble || inDollar) { i++; continue; }

    if (ch === "\n" || ch === ";") {
      if (hasContentSinceSep) count++;
      hasContentSinceSep = false;
      i++;
      continue;
    }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      if (hasContentSinceSep) count++;
      hasContentSinceSep = false;
      i += 2;
      continue;
    }

    if (ch !== " " && ch !== "\t") hasContentSinceSep = true;
    i++;
  }
  if (hasContentSinceSep) count++;
  return count;
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
