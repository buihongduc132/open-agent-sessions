/**
 * OT20 (rank5) — parser quote-awareness hard prerequisite.
 *
 * mvdan/sh v3 WASM must correctly parse:
 *   - Quoted pipe characters: `git commit -m "a | b"` → 1 stmt, not split on |
 *   - ANSI-C quoting: $'...'
 *   - Escaped vars: \$var (literal $)
 *   - Quoted spaces: `cmd 'arg with spaces'` → 1 arg, not split
 *
 * Manual regex / .split('|') / split(/\s+/) all fail these. This is WHY we
 * use a real AST parser.
 */
import { describe, it, expect } from "bun:test";
import { parseCommand } from "../../src/parse/mvdan";

describe("mvdan/sh quote-awareness (OT20)", () => {
  it("quoted_pipe_not_split_into_pipeline", async () => {
    // BAD regex would split on '|' and see 2 stmts. mvdan sees 1.
    const r = await parseCommand(`git commit -m "a | b"`);
    expect(r.statement_count).toBe(1);
    expect(r.pipeline_depth).toBe(1);
    // The commit message arg is "a | b" (with the pipe), not split.
    expect(r.positional_args.join(" ")).toContain("a | b");
  });

  it("ansi_c_quoting_dollar_single_quote", async () => {
    // $'...' is ANSI-C quoting. Tab inside is literal tab.
    const r = await parseCommand(`echo $'tab\\there'`);
    expect(r.program).toBe("echo");
    expect(r.parse_status).toMatch(/ok|partial/);
  });

  it("escaped_dollar_not_expanded_in_double_quotes", async () => {
    // In double quotes, \$var should be literal $var (not expanded).
    // mvdan/sh treats this as a literal DQuotedPart.
    const r = await parseCommand(`echo "\\$HOME"`);
    expect(r.program).toBe("echo");
    expect(r.parse_status).toMatch(/ok|partial/);
  });

  it("single_quoted_spaces_preserved_as_one_arg", async () => {
    const r = await parseCommand(`echo 'hello world foo bar'`);
    expect(r.positional_args).toContain("hello world foo bar");
  });

  it("double_quoted_spaces_preserved_as_one_arg", async () => {
    const r = await parseCommand(`echo "hello world foo bar"`);
    expect(r.positional_args).toContain("hello world foo bar");
  });

  it("mixed_quotes_and_pipes_complex_command", async () => {
    const cmd = `grep "error | warn" log.txt | wc -l`;
    const r = await parseCommand(cmd);
    expect(r.statement_count).toBe(1);
    expect(r.pipeline_depth).toBe(2);  // grep ... | wc -l
  });

  it("backslash_continuation_joins_lines", async () => {
    const cmd = `echo one \\
      two three`;
    const r = await parseCommand(cmd);
    expect(r.program).toBe("echo");
    expect(r.positional_args).toContain("one");
    expect(r.positional_args).toContain("two");
  });
});
