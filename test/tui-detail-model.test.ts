<<<<<<< Updated upstream
import { describe, expect, test } from "bun:test";

// SKIP: TUI is out of scope for v1 (see epic oas-d4a: "TUI later phase")
// These tests will be enabled when TUI implementation is ready

describe.skip("tui detail model", () => {
  test("placeholder - TUI tests disabled for v1", () => {
    expect(true).toBe(true);
=======
// TUI is out of scope for v1 (epic oas-d4a: "TUI later phase")
// Skipping all TUI tests until v2
import { describe, test } from "bun:test";

describe.skip("tui detail model", () => {
  test("skipped - TUI out of scope for v1", () => {
    // TUI tests will be implemented in v2
>>>>>>> Stashed changes
  });
});
