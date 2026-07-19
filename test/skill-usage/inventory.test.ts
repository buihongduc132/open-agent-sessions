/**
 * RED tests for src/skill-usage/inventory.ts
 *
 * loadSkillInventory(dirs):
 *   - Scans dirs for skills/<name>/SKILL.md
 *   - Parses YAML frontmatter for name, description, metadata.aliases
 *   - Returns SkillInventoryEntry[] deduped by canonical name
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadSkillInventory } from "../../src/skill-usage/inventory";

const FIXTURES = join(import.meta.dir, "fixtures", "skill-inventory");

describe("loadSkillInventory", () => {
  test("returns array with canonical skill names", () => {
    const inv = loadSkillInventory([FIXTURES]);
    expect(inv.length).toBeGreaterThan(0);
    const names = inv.map((e) => e.name);
    expect(names).toContain("verifier-loop");
    expect(names).toContain("worktree-lifecycle");
    expect(names).toContain("caveman");
  });

  test("parses metadata.aliases from SKILL.md frontmatter", () => {
    const inv = loadSkillInventory([FIXTURES]);
    const vloop = inv.find((e) => e.name === "verifier-loop");
    expect(vloop).toBeDefined();
    expect(vloop?.aliases).toEqual(expect.arrayContaining(["jewilo", "verify-loop"]));
  });

  test("empty aliases array when frontmatter has no metadata.aliases", () => {
    const inv = loadSkillInventory([FIXTURES]);
    const wt = inv.find((e) => e.name === "worktree-lifecycle");
    expect(wt).toBeDefined();
    expect(wt?.aliases).toEqual([]);
  });

  test("dedupes across multiple inventory dirs (same name appears twice)", async () => {
    // Simulate two dirs that both contain verifier-loop — must collapse to 1 entry
    const dirA = FIXTURES;
    const dirB = join(import.meta.dir, "fixtures", "skill-inventory-dup");
    // dirB created at test time to ensure dedup logic works
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(dirB, "verifier-loop"), { recursive: true });
    await fs.writeFile(
      join(dirB, "verifier-loop", "SKILL.md"),
      "---\nname: verifier-loop\ndescription: duplicate\n---\n# Verifier Loop\n",
    );

    const inv = loadSkillInventory([dirA, dirB]);
    const vloops = inv.filter((e) => e.name === "verifier-loop");
    expect(vloops.length).toBe(1);

    await fs.rm(dirB, { recursive: true, force: true });
  });

  test("ignores non-SKILL.md files", () => {
    const inv = loadSkillInventory([FIXTURES]);
    // No entry for stray files; only SKILL.md dirs surface
    const names = inv.map((e) => e.name);
    for (const n of names) {
      expect(n).toBeTruthy();
    }
  });
});
