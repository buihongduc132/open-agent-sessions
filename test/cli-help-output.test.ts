import { describe, expect, test, beforeAll } from "bun:test";
import { runCLI } from "./helpers/run-cli";

const CI = !!process.env.CI;

// ============================================================================
// Tests for the NEW help output structure after `oas session <action>` refactor
// ============================================================================

describe.skipIf(CI)("CLI: new help output structure (oas session <action>)", () => {
  let help: string;

  beforeAll(async () => {
    const result = await runCLI(["--help"]);
    help = result.stdout;
  });

  // --- Session resource group ---
  test("help contains 'session' resource group", () => {
    expect(help).toContain("session");
  });

  test("help contains 'session list' primary command", () => {
    expect(help).toContain("session list");
  });

  test("help contains 'session read' command", () => {
    expect(help).toContain("session read");
  });

  test("help contains 'session detail' command", () => {
    expect(help).toContain("session detail");
  });

  test("help contains 'session export' command", () => {
    expect(help).toContain("session export");
  });

  test("help contains 'session clone' command", () => {
    expect(help).toContain("session clone");
  });

  test("help contains 'session search' command", () => {
    expect(help).toContain("session search");
  });

  test("help contains 'session similar' command", () => {
    expect(help).toContain("session similar");
  });

  // --- Top-level utilities ---
  test("help contains 'config' utility", () => {
    expect(help).toContain("config");
  });

  test("help contains 'onboard' utility", () => {
    expect(help).toContain("onboard");
  });

  test("help contains 'tui' utility", () => {
    expect(help).toContain("tui");
  });

  // --- Removed commands ---
  test("help does NOT contain 'list-new' (removed command)", () => {
    expect(help).not.toContain("list-new");
  });

  // --- Filtering flags ---
  test("help contains '--last DURATION' time filtering flag", () => {
    expect(help).toContain("--last DURATION");
  });

  test("help contains '--agent NAME' filter flag", () => {
    expect(help).toContain("--agent NAME");
  });

  // --- Examples ---
  test("help contains 'Examples:' section", () => {
    expect(help).toContain("Examples:");
  });

  test("help contains 'oas session' in examples", () => {
    expect(help).toContain("oas session");
  });
});
