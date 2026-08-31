/**
 * RED — export flag parsing tests (oas-export-turn-split).
 * RED state: src/cli/export-options.ts stubs throw "not implemented".
 */
import { describe, test, expect } from "bun:test";
import { parseExportFlags, exportHelpText } from "../src/cli/export-options";

describe("parseExportFlags — value forms", () => {
  test("negative int tokens accepted as VALUES for bounds flags (separate-arg form)", () => {
    const r = parseExportFlags(["--from-relative", "-1", "--to-relative", "-3"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.fromRelative).toBe("-1");
      expect(r.value.toRelative).toBe("-3");
    }
  });

  test("--flag=value eqform equals separate-arg form", () => {
    const r = parseExportFlags(["--from-relative=-3", "--to-relative=0"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.fromRelative).toBe("-3");
      expect(r.value.toRelative).toBe("0");
    }
  });

  test("numeric-looking string flags never Number-coerced", () => {
    const r = parseExportFlags([
      "--id", "12345",
      "--prefix", "001",
      "--dir", "123",
      "--output", "123",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe("12345");
      expect(typeof r.value.id).toBe("string");
      expect(r.value.prefix).toBe("001");
      expect(typeof r.value.prefix).toBe("string");
      expect(r.value.dir).toBe("123");
      expect(typeof r.value.dir).toBe("string");
    }
  });

  test("positional session-ref captured; agent/id flags parsed", () => {
    const r = parseExportFlags(["pi:abc123", "--agent", "pi", "--id", "abc123"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sessionRef).toBe("pi:abc123");
      expect(r.value.agent).toBe("pi");
      expect(r.value.id).toBe("abc123");
    }
  });

  test("all flag values cross parser boundary as STRINGS", () => {
    const r = parseExportFlags(["--from", "5", "--to", "9", "--format", "markdown"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.value.fromTurn).toBe("string");
      expect(typeof r.value.toTurn).toBe("string");
      expect(r.value.fromTurn).toBe("5");
      expect(r.value.toTurn).toBe("9");
      expect(r.value.format).toBe("markdown");
    }
  });

  test("tilde kept verbatim in parser for --dir (expansion later)", () => {
    for (const argv of [["--dir", "~/out"], ["--dir=~/out"]]) {
      const r = parseExportFlags(argv as string[]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.dir).toBe("~/out");
    }
  });
});

describe("parseExportFlags — with-* family", () => {
  test("--with-tools maps to tool+tool_result; raw flag recorded", () => {
    const r = parseExportFlags(["--with-tools"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.withTypes).toContain("tool");
      expect(r.value.withTypes).toContain("tool_result");
      expect(r.value.rawWithFlags).toContain("with-tools");
    }
  });

  test("--with-thinking maps to reasoning alias", () => {
    const r = parseExportFlags(["--with-thinking"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.withTypes).toContain("reasoning");
  });

  test("generic --with-X maps to type X; multiple additive", () => {
    const r = parseExportFlags(["--with-foo", "--with-tools"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.withTypes).toContain("foo");
      expect(r.value.withTypes).toContain("tool");
      expect(r.value.rawWithFlags).toContain("with-foo");
    }
  });
});

describe("parseExportFlags — unknown + duplicate flags", () => {
  test("unknown flag → hard error listing valid flags, exitCode 2", () => {
    const r = parseExportFlags(["--frm", "x"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.exitCode).toBe(2);
      expect(r.errors.join(" ")).toMatch(/--from|--dir|--id|valid/i);
    }
    const r2 = parseExportFlags(["--typo"]);
    expect(r2.ok).toBe(false);
  });

  test("duplicate same flag rejected (never silent last-wins)", () => {
    const r = parseExportFlags(["--from-relative", "-1", "--from-relative", "-3"]);
    expect(r.ok).toBe(false);
  });

  test("simultaneous violations collected, not first-only", () => {
    const r = parseExportFlags(["--frm", "x", "--id", "abc"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("parseExportFlags — boolean flags =value handling", () => {
  test("--dry-run=false → false; =true → true; =x → error", () => {
    const f = parseExportFlags(["--dry-run=false"]);
    expect(f.ok).toBe(true);
    if (f.ok) expect(f.value.dryRun).toBe(false);
    const t = parseExportFlags(["--dry-run=true"]);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.value.dryRun).toBe(true);
    const x = parseExportFlags(["--dry-run=x"]);
    expect(x.ok).toBe(false);
  });

  test("bare --dry-run/--force booleans", () => {
    const r = parseExportFlags(["--dry-run", "--force", "--dir", "d"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.dryRun).toBe(true);
      expect(r.value.force).toBe(true);
    }
  });
});

describe("parseExportFlags — conflict matrix (exitCode 2)", () => {
  const expectConflict = (argv: string[], needle: string) => {
    const r = parseExportFlags(argv);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.exitCode).toBe(2);
      expect(r.errors.join(" ").toLowerCase()).toContain(needle.toLowerCase());
    }
  };

  test("--id without --agent", () =>
    expectConflict(["--id", "abc123"], "--agent"));
  test("--agent + positional ref disagreeing id", () =>
    expectConflict(["pi:xyz", "--agent", "pi", "--id", "abc"], "id"));
  test("--from + --from-relative together", () =>
    expectConflict(["--from", "pi:abc", "--from-relative", "-1"], "--from"));
  test("--output + --dir together", () =>
    expectConflict(["--output", "f.md", "--dir", "d"], "--output"));
  test("--type without --dir", () =>
    expectConflict(["--type", "consolidate", "--agent", "pi", "--id", "x"], "--dir"));
  test("--dry-run without --dir", () =>
    expectConflict(["--dry-run", "--agent", "pi", "--id", "x"], "--dir"));
  test("--prefix without --dir", () =>
    expectConflict(["--prefix", "p", "--agent", "pi", "--id", "x"], "--dir"));
  test("turn bounds without --dir/--output", () =>
    expectConflict(["--from-relative", "-1", "--agent", "pi", "--id", "x"], "--dir"));
  test("--id + --from together", () =>
    expectConflict(["--id", "x", "--from", "pi:y"], "--from"));
});

describe("parseExportFlags — domain validation", () => {
  test("positive relative value → error with --from hint", () => {
    const r = parseExportFlags(["--from-relative", "1", "--dir", "d"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("--from");
  });

  test("negative absolute value → error", () => {
    const r = parseExportFlags(["--from", "-1", "--dir", "d"]);
    expect(r.ok).toBe(false);
  });

  test("-0 rejected; 0 valid", () => {
    expect(parseExportFlags(["--from-relative", "-0", "--dir", "d"]).ok).toBe(false);
    expect(parseExportFlags(["--from-relative", "0", "--dir", "d"]).ok).toBe(true);
  });

  test("type/format value validation", () => {
    expect(parseExportFlags(["--type", "bogus", "--dir", "d"]).ok).toBe(false);
    expect(parseExportFlags(["--type", "split_turn", "--dir", "d"]).ok).toBe(true);
    expect(parseExportFlags(["--type", "consolidate", "--dir", "d"]).ok).toBe(true);
    expect(parseExportFlags(["--format", "bogus"]).ok).toBe(false);
    expect(parseExportFlags(["--format", "markdown"]).ok).toBe(true);
  });

  test("int-parse validation runs before conflict checks (both collected)", () => {
    const r = parseExportFlags(["--from-relative", "zz", "--id", "abc"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("exportHelpText", () => {
  test("leads with relative example; relative before absolute; documents 0/-1 semantics", () => {
    const help = exportHelpText();
    expect(help).toContain("--from-relative=-3");
    expect(help).toContain("--to-relative 0");
    const relIdx = help.indexOf("--from-relative");
    const absIdx = help.indexOf("--from ");
    expect(relIdx).toBeGreaterThan(-1);
    expect(absIdx).toBeGreaterThan(relIdx);
    expect(help).toContain("0");
    expect(/current/i.test(help)).toBe(true);
    expect(/-1.*previous|previous.*-1/i.test(help)).toBe(true);
  });
});
