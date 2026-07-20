#!/usr/bin/env bun
/**
 * Run src/skill-usage analyzer against the live pi sessions + skill inventory
 * and emit a heatmap-style report (last N days, default 7).
 *
 * Usage:
 *   bun run scripts/skill-usage-heatmap.ts [--days N] [--max-distance 1|2|3]
 *
 * Output: stdout = ranked heatmap table. Cache under .cache/skill-usage/.
 */
import { analyzeSkillUsage } from "../src/skill-usage/analyzer";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const SESSIONS_DIR = join(HOME, ".pi/agent/sessions");
const INVENTORY_DIRS = [
  join(HOME, ".agents/skills"),
  join(HOME, ".pi/agent/skills"),
  join(HOME, ".pi/agent/git/github.com/buihongduc132/pi-acp-agents/skills"),
  join(HOME, ".pi/agent/git/github.com/buihongduc132/pi-gitnexus/skills"),
  join(HOME, ".pi/agent/git/github.com/buihongduc132/pi-holdpty/skills"),
  join(HOME, ".pi/agent/git/github.com/buihongduc132/pi-intercom/skills"),
  join(HOME, ".pi/agent/git/github.com/buihongduc132/pi-email-integration/skills"),
  join(HOME, ".pi/agent/git/github.com/buihongduc132/pi-ralph-wiggum/skills"),
  join(HOME, ".pi/agent/git/github.com/buihongduc132/pi-unify-cmd/skills"),
  join(HOME, ".pi/agent/git/github.com/buihongduc132/pi-ctx-budget/skills"),
  join(HOME, ".pi/agent/git/github.com/omaclaren/pi-markdown-preview/skills"),
];
const CACHE_DIR = join(process.cwd(), ".cache/skill-usage");

// parse args
const args = process.argv.slice(2);
let days = 7;
let maxDistance: 1 | 2 | 3 = 2;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--days" && args[i + 1]) days = parseInt(args[i + 1], 10);
  if (args[i] === "--max-distance" && args[i + 1]) {
    const v = parseInt(args[i + 1], 10) as 1 | 2 | 3;
    if (v === 1 || v === 2 || v === 3) maxDistance = v;
  }
}

const t0 = Date.now();
const report = await analyzeSkillUsage({
  sessionsDir: SESSIONS_DIR,
  inventoryDirs: INVENTORY_DIRS,
  cacheDir: CACHE_DIR,
  days,
  fuzzy: { enabled: true, maxDistance },
});
const wallMs = Date.now() - t0;

// rank skills by combined activity
// rank skills by combined activity — but for sorting, count only high-confidence mentions
// (T2 normalized + T3 alias + T4 fuzzy-that-looks-like-skill-name, NOT common-word noise)
const scoreOf = (r: typeof rows[number]) => {
  const safeMentions = (r.matchedVariants ?? [])
    .filter((v) => {
      if (v.tier === "normalized" || v.tier === "alias") return true;
      if (v.tier === "fuzzy") {
        const skillLen = r.skill.length;
        const isShortSkill = skillLen <= 4;
        const isLikelyTypo = v.distance === 1;
        const variantIncludesSkill = v.variant.toLowerCase().includes(r.skill.toLowerCase().split("-")[0]);
        return !isShortSkill && (isLikelyTypo || variantIncludesSkill);
      }
      return false;
    })
    .reduce((s, v) => s + v.count, 0);
  return r.loads * 10 + safeMentions + (r.mentions > 0 && r.loads === 0 ? 1 : 0);
};

const rows = Object.values(report.bySkill)
  .filter((r) => r.loads > 0 || r.mentions > 0)
  .sort((a, b) => scoreOf(b) - scoreOf(a));

const fmt = (n: number) => n.toString().padStart(6);

console.log("");
console.log(`# Pi skill usage heatmap — last ${days} days (maxDistance=${maxDistance})`);
console.log("");
console.log(
  `Scanned: ${report.scannedSessions} sessions, cached: ${report.cachedSessions}, ` +
    `analyzer: ${report.elapsedMs}ms, wall: ${wallMs}ms`,
);
console.log(
  `Total skills in inventory observed: ${rows.length} / cache size at ${CACHE_DIR}`,
);
console.log("");
console.log("## HOT — ranked by (loads×10 + mentions)");
console.log("");
console.log(
  "| loads | mentions | sessions | skill | first-seen → last-seen | top variants |",
);
console.log(
  "|------:|---------:|---------:|-------|------------------------|--------------|",
);
for (const r of rows.slice(0, 30)) {
  const variants = (r.matchedVariants ?? [])
    .filter((v) => {
      if (v.tier === "normalized" || v.tier === "alias") return true;
      if (v.tier === "fuzzy") {
        const skillLen = r.skill.length;
        const isShortSkill = skillLen <= 4;
        const isLikelyTypo = v.distance === 1;
        const variantIncludesSkill = v.variant.toLowerCase().includes(r.skill.toLowerCase().split("-")[0]);
        return !isShortSkill && (isLikelyTypo || variantIncludesSkill);
      }
      return false;
    })
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((v) => `${v.variant}(${v.tier[0].toUpperCase()}d${v.distance})×${v.count}`)
    .join(", ");
  console.log(
    `| ${fmt(r.loads)} | ${fmt(r.mentions)} | ${fmt(r.sessions)} | ${r.skill} | ` +
      `${r.firstSeen?.slice(0, 10) ?? "?"} → ${r.lastSeen?.slice(0, 10) ?? "?"} | ${variants} |`,
  );
}

if (rows.length > 30) {
  console.log("");
  console.log(`... ${rows.length - 30} more skills with activity not shown.`);
}

console.log("");
console.log(`## Tier breakdown (across all ${rows.length} skills with activity)`);
let exact = 0,
  norm = 0,
  alias = 0,
  fuzzy = 0,
  fuzzy_total = 0,
  fuzzy_dropped = 0;
for (const r of rows) {
  for (const v of r.matchedVariants ?? []) {
    if (v.tier === "normalized") norm += v.count;
    if (v.tier === "alias") alias += v.count;
    // Only count T4 fuzzy variants that look like skill-name shapes:
    // - distance 1 (typos), OR
    // - candidate contains the skill's name as a prefix/substring (hyphen/space variants)
    // - skip pure common-word noise (distance 2 from a 2-3 char skill like bd/abw)
    if (v.tier === "fuzzy") {
      fuzzy_total += v.count;
      const skillLen = r.skill.length;
      const isShortSkill = skillLen <= 4;
      const isLikelyTypo = v.distance === 1;
      const variantIncludesSkill = v.variant.toLowerCase().includes(r.skill.toLowerCase().split("-")[0]);
      if (!isShortSkill && (isLikelyTypo || variantIncludesSkill)) {
        fuzzy += v.count;
      } else {
        fuzzy_dropped += v.count;
      }
    }
  }
}
console.log(`- T1 exact (loads counted separately): ${exact} variant hits`);
console.log(`- T2 normalized: ${norm}`);
console.log(`- T3 alias: ${alias}`);
console.log(`- T4 fuzzy (filtered for skill-name-shape): ${fuzzy} (maxObservedDistance=${report.maxObservedDistance})`);
console.log(`- T4 fuzzy DROPPED as common-word noise: ${fuzzy_dropped} (out of ${fuzzy_total} raw)`);
console.log(`- T1 exact (loads counted separately): ${exact} variant hits`);
console.log(`- T2 normalized: ${norm}`);
console.log(`- T3 alias: ${alias}`);
console.log(`- T4 fuzzy: ${fuzzy} (maxObservedDistance=${report.maxObservedDistance})`);
