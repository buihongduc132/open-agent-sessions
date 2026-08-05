/**
 * AST walk — extract structured fields from mvdan/sh parse tree:
 *   - program (first word)
 *   - subcommand (second word if present, e.g. "commit" in "git commit")
 *   - positional_args (non-flag args after program/subcommand)
 *   - flags (expanded short-flag runs: -rnE → -r -n -E)
 *   - pipeline_depth (count of | separated commands)
 *   - statement_count (count of ; && || separated statements)
 */
import { describe, it, expect } from "bun:test";
import { parseCommand } from "../../src/parse/mvdan";

describe("AST walk field extraction", () => {
  it("simple_command_program_and_args", async () => {
    const r = await parseCommand("echo hello world");
    expect(r.program).toBe("echo");
    expect(r.positional_args).toEqual(["hello", "world"]);
    expect(r.flags).toEqual([]);
    expect(r.pipeline_depth).toBe(1);
    expect(r.statement_count).toBe(1);
  });

  it("git_subcommand_detected", async () => {
    const r = await parseCommand("git commit -m message");
    expect(r.program).toBe("git");
    expect(r.subcommand).toBe("commit");
  });

  it("flags_separated_from_positional_args", async () => {
    const r = await parseCommand("ls -la --color=auto /tmp");
    expect(r.program).toBe("ls");
    expect(r.flags.length).toBeGreaterThan(0);
    expect(r.flags.some(f => f.startsWith("-l"))).toBe(true);
    expect(r.positional_args).toContain("/tmp");
  });

  it("pipeline_depth_counts_pipe_segments", async () => {
    const r1 = await parseCommand("cat f.txt | grep x");
    expect(r1.pipeline_depth).toBe(2);

    const r2 = await parseCommand("a | b | c | d");
    expect(r2.pipeline_depth).toBe(4);
  });

  it("statement_count_counts_logical_statements", async () => {
    const r1 = await parseCommand("a && b");
    expect(r1.statement_count).toBe(2);

    const r2 = await parseCommand("a || b ; c");
    expect(r2.statement_count).toBe(3);

    const r3 = await parseCommand("a");
    expect(r3.statement_count).toBe(1);
  });

  it("combined_short_flags_can_be_split", async () => {
    // -rnE is shorthand for -r -n -E (e.g. grep). OT5-G1.
    const r = await parseCommand("grep -rnE pattern .");
    expect(r.flags.some(f => f === "-r" || f === "--recursive")).toBe(true);
    expect(r.flags.some(f => f === "-n" || f === "--line-number")).toBe(true);
    expect(r.flags.some(f => f === "-E" || f === "--extended-regexp")).toBe(true);
  });
});
