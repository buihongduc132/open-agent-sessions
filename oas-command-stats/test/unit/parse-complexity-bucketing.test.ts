/**
 * OT43 — complexity bucketing for parse-rate measurement.
 *
 * Bucket commands by structural complexity to set realistic success-rate
 * targets: ≥99% on simple, ≥95% on medium+complex.
 *
 *   simple  : 1 statement, no pipes, no subst — `ls`, `git status`, `echo x`
 *   medium  : 1-2 pipes OR && chains OR single subshell — `a | b`, `a && b`
 *   complex : 3+ statements, nested $()/``/$'', heredocs, for-loops, find -exec
 */
import { describe, it, expect } from "bun:test";
import { bucketComplexity } from "../../src/parse/complexity";

describe("complexity bucketing (OT43)", () => {
  it("simple_single_command_bucketed_simple", () => {
    expect(bucketComplexity("ls -la")).toBe("simple");
    expect(bucketComplexity("git status")).toBe("simple");
    expect(bucketComplexity("echo hello")).toBe("simple");
    expect(bucketComplexity("pwd")).toBe("simple");
  });

  it("pipeline_two_segments_bucketed_medium", () => {
    expect(bucketComplexity("cat f | grep x")).toBe("medium");
    expect(bucketComplexity("a && b")).toBe("medium");
    expect(bucketComplexity("a || b")).toBe("medium");
  });

  it("three_or_more_statements_bucketed_complex", () => {
    expect(bucketComplexity("a && b && c")).toBe("complex");
    expect(bucketComplexity("a | b | c | d")).toBe("complex");
    expect(bucketComplexity("a ; b ; c")).toBe("complex");
  });

  it("command_substitution_bucketed_complex", () => {
    expect(bucketComplexity("x=$(curl url)")).toBe("complex");
    expect(bucketComplexity("diff <(sort a) <(sort b)")).toBe("complex");
    expect(bucketComplexity("for f in *.ts; do echo $f; done")).toBe("complex");
  });

  it("heredoc_bucketed_complex", () => {
    expect(bucketComplexity("cat <<EOF\nhi\nEOF")).toBe("complex");
  });

  it("ansi_c_quoting_bucketed_complex", () => {
    expect(bucketComplexity("echo $'\\t'")).toBe("complex");
  });

  it("empty_or_comment_bucketed_simple", () => {
    expect(bucketComplexity("")).toBe("simple");
    expect(bucketComplexity("# comment")).toBe("simple");
    expect(bucketComplexity(":")).toBe("simple");
  });
});
