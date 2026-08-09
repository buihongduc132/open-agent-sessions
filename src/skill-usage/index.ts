/**
 * src/skill-usage/index.ts
 *
 * Public re-exports for the skill-usage analyzer module.
 */

export { analyzeSkillUsage } from "./analyzer";
export { loadSkillInventory } from "./inventory";
export { extractSkillReads, extractSkillMentions } from "./parser";
export { openCache, computeFingerprint, type SkillUsageCache } from "./cache";
export { canonicalize, damerauLevenshtein, matchTier } from "./fuzzy";
export type { MatchResult, MatchTier } from "./types";
export type {
  SkillInventoryEntry,
  SkillMatch,
  SkillUsageOptions,
  SkillUsageRecord,
  SkillUsageReport,
  SkillUsageVariant,
} from "./types";
