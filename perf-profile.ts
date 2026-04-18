// perf-profile.ts — measure TUI operation timings (list load, detail open, search, clone)
import { loadConfigFromFile } from "./src/config/index.ts";
import { createAdapterRegistry } from "./src/core/registry.ts";
import {
  createOpenCodeAdapter,
  createCodexAdapter,
  createClaudeAdapter,
  createAcpxAdapter,
} from "./src/adapters/index.ts";
import { listSessions } from "./src/core/list.ts";
import { cloneSession } from "./src/core/clone.ts";
import type { AdapterRegistry, SessionSummary } from "./src/core/types.ts";

const SLOW_MS = 5000;
const results: { label: string; durationMs: number; slow: boolean }[] = [];

function record(label: string, ms: number) {
  const slow = ms > SLOW_MS;
  results.push({ label, durationMs: ms, slow });
  const tag = slow ? "⚠️ SLOW" : "✅";
  const msStr = String(ms).padStart(6);
  console.log(`${tag} [${msStr}ms] ${label}`);
}

async function getDetail(
  registry: AdapterRegistry,
  session: SessionSummary
): Promise<number> {
  const t0 = Date.now();
  for (const adapter of registry.adapters) {
    if (adapter.agent === session.agent && adapter.alias === session.alias) {
      // Use the adapter's getSessionDetail directly
      if (adapter.getSessionDetail) {
        await adapter.getSessionDetail(session.id, {});
      }
      break;
    }
  }
  return Date.now() - t0;
}

async function main() {
  console.log("=== OAS TUI Performance Profile ===\n");

  let config;
  try {
    config = await loadConfigFromFile(
      "/home/bhd/Documents/Projects/bhd/open-agent-sessions/oas.config.yaml"
    );
  } catch (e) {
    console.error("Config load failed:", e);
    return;
  }

  const cwd = "/home/bhd/Documents/Projects/bhd/open-agent-sessions";
  const factories = {
    opencode: (entry: any) => createOpenCodeAdapter(entry, { cwd }),
    codex: (entry: any) => createCodexAdapter(entry, { defaultPath: entry.path }),
    claude: (entry: any) => createClaudeAdapter(entry, {}),
    acpx: (entry: any) => createAcpxAdapter(entry, {}),
  };
  const registry = createAdapterRegistry(config, factories);

  // ── 1. Full list (all agents) ─────────────────────────────────────────────
  {
    const t0 = Date.now();
    const r = await listSessions(registry, {});
    record(`list() — all agents, ${r.sessions.length} sessions`, Date.now() - t0);
  }

  // ── 2. List with limit ─────────────────────────────────────────────────────
  {
    const t0 = Date.now();
    const r = await listSessions(registry, { limit: 20 });
    record(`list(limit=20) — ${r.sessions.length} sessions`, Date.now() - t0);
  }

  // ── 3. List with pagination ─────────────────────────────────────────────────
  {
    const t0 = Date.now();
    const r1 = await listSessions(registry, { limit: 2 });
    const cursor = r1.nextCursor;
    const r2 = await listSessions(registry, { limit: 2, after: cursor ?? undefined });
    record(
      `list paginated(page2) — ${r2.sessions.length} sessions`,
      Date.now() - t0
    );
  }

  // ── 4. Per-agent list (opencode) ───────────────────────────────────────────
  {
    const t0 = Date.now();
    const r = await listSessions(registry, { agent: "opencode" });
    record(`list(agent=opencode) — ${r.sessions.length} sessions`, Date.now() - t0);
  }

  // ── 5. Per-agent list (codex) ──────────────────────────────────────────────
  {
    const t0 = Date.now();
    const r = await listSessions(registry, { agent: "codex" });
    record(`list(agent=codex) — ${r.sessions.length} sessions`, Date.now() - t0);
  }

  // ── 6. Text search (q=query) ────────────────────────────────────────────────
  {
    const t0 = Date.now();
    const r = await listSessions(registry, { q: "test" });
    record(`list(q="test") — ${r.sessions.length} sessions`, Date.now() - t0);
  }

  // ── 7. Open detail for first opencode session ────────────────────────────────
  const allSessions = await listSessions(registry, {});
  const firstOC = allSessions.sessions.find((s) => s.agent === "opencode");
  if (firstOC) {
    const t0 = Date.now();
    await getDetail(registry, firstOC);
    record(
      `getSession(opencode ${firstOC.id})`,
      Date.now() - t0
    );
  }

  // ── 8. Open detail for codex session ───────────────────────────────────────
  const firstCodex = allSessions.sessions.find((s) => s.agent === "codex");
  if (firstCodex) {
    const t0 = Date.now();
    await getDetail(registry, firstCodex);
    record(`getSession(codex ${firstCodex.id})`, Date.now() - t0);
  }

  // ── 9. Cache hit: re-open same opencode session ──────────────────────────────
  if (firstOC) {
    const t0 = Date.now();
    await getDetail(registry, firstOC);
    record(`getSession CACHED(${firstOC.id}) — 2nd call`, Date.now() - t0);
  }

  // ── 10. Sequential detail opens (opencode, top 5) ──────────────────────────
  {
    const top5 = (await listSessions(registry, { agent: "opencode" }))
      .sessions.slice(0, 5);
    for (const s of top5) {
      const t0 = Date.now();
      await getDetail(registry, s);
      record(`sequential getSession(${s.id})`, Date.now() - t0);
    }
  }

  // ── 11. Clone (if codex session available) ───────────────────────────────────
  if (firstCodex) {
    const t0 = Date.now();
    try {
      await cloneSession(
        {
          source: { agent: firstCodex.agent, alias: firstCodex.alias, session_id: firstCodex.id },
          destination: { agent: "opencode", alias: "default" },
        },
        registry
      );
      record(`clone(codex→opencode)`, Date.now() - t0);
    } catch (e) {
      console.log(`✅ clone skipped: ${e}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const slow = results.filter((r) => r.slow);
  console.log("\n=== SUMMARY ===");
  console.log(`Total operations: ${results.length}`);
  console.log(`Slow ( >${SLOW_MS}ms): ${slow.length}`);

  if (slow.length > 0) {
    console.log("\n⚠️  SLOW OPERATIONS:");
    for (const r of slow) {
      console.log(`  ⚠️  [${r.durationMs}ms] ${r.label}`);
    }
  } else {
    console.log("\n✅ No operations exceeded 5000ms threshold.");
  }

  const totalMs = results.reduce((a, r) => a + r.durationMs, 0);
  console.log(`\nTotal wall time: ${totalMs}ms`);
  console.log(`Average per op: ${Math.round(totalMs / results.length)}ms`);
  console.log(`\nSlowest: ${Math.max(...results.map((r) => r.durationMs))}ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
