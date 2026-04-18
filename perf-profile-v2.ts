// perf-profile-v2.ts — measure IMPROVED paths only (F6 agent routing, skipSessionId)
import { loadConfigFromFile } from "./src/config/index.ts";
import { createAdapterRegistry } from "./src/core/registry.ts";
import {
  createOpenCodeAdapter,
  createCodexAdapter,
  createClaudeAdapter,
  createAcpxAdapter,
} from "./src/adapters/index.ts";
import { listSessions } from "./src/core/list.ts";
import type { AdapterRegistry, SessionSummary } from "./src/core/types.ts";

const SLOW_MS = 5000;
const results: { label: string; durationMs: number; slow: boolean }[] = [];

function record(label: string, ms: number) {
  const slow = ms > SLOW_MS;
  results.push({ label, durationMs: ms, slow });
  const tag = slow ? "⚠️ SLOW" : "✅";
  const msStr = String(ms).padStart(7);
  console.log(`${tag} [${msStr}ms] ${label}`);
}

async function getDetail(registry: AdapterRegistry, session: SessionSummary): Promise<number> {
  const t0 = Date.now();
  for (const adapter of registry.adapters) {
    if (adapter.agent === session.agent && adapter.alias === session.alias) {
      if (adapter.getSessionDetail) {
        await adapter.getSessionDetail(session.id, {});
      }
      break;
    }
  }
  return Date.now() - t0;
}

async function main() {
  console.log("=== OAS TUI Performance Profile v2 ===\n");

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

  // ── F6 impact: agent-filtered calls (should skip non-matching adapters) ────────
  {
    const t0 = Date.now();
    const r = await listSessions(registry, { agent: "opencode" });
    record(`F6: list(agent=opencode) — ${r.sessions.length} sessions`, Date.now() - t0);
  }

  {
    const t0 = Date.now();
    const r = await listSessions(registry, { agent: "codex" });
    record(`F2: list(agent=codex) — ${r.sessions.length} sessions`, Date.now() - t0);
  }

  // ── F6 + limit: single-agent with pagination ────────────────────────────────
  {
    const t0 = Date.now();
    const r1 = await listSessions(registry, { agent: "opencode", limit: 2 });
    const cursor = r1.nextCursor;
    const r2 = await listSessions(registry, { agent: "opencode", limit: 2, after: cursor ?? undefined });
    record(`F6: list(agent=opencode, paginated page2) — ${r2.sessions.length} sessions`, Date.now() - t0);
  }

  // ── F6: alias-filtered call ────────────────────────────────────────────────
  {
    const t0 = Date.now();
    const r = await listSessions(registry, { alias: "default" });
    record(`F6: list(alias=default) — ${r.sessions.length} sessions`, Date.now() - t0);
  }

  // ── getSession detail cache (should be fast) ───────────────────────────────
  const allSessions = await listSessions(registry, { agent: "opencode", limit: 5 });
  const firstOC = allSessions.sessions[0];
  if (firstOC) {
    const t0 = Date.now();
    await getDetail(registry, firstOC);
    record(`getSession(opencode, uncached)`, Date.now() - t0);

    // Second call: cache hit
    const t1 = Date.now();
    await getDetail(registry, firstOC);
    record(`getSession(opencode, CACHED 2nd call)`, Date.now() - t1);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const slow = results.filter((r) => r.slow);
  console.log("\n=== SUMMARY ===");
  console.log(`Total operations: ${results.length}`);
  console.log(`Slow ( >${SLOW_MS}ms): ${slow.length}`);
  if (slow.length > 0) {
    console.log("\n⚠️  SLOW OPERATIONS (remaining bottlenecks):");
    for (const r of slow) {
      console.log(`  ⚠️  [${r.durationMs}ms] ${r.label}`);
    }
  } else {
    console.log("\n✅ No operations exceeded 5000ms threshold.");
  }
  const totalMs = results.reduce((a, r) => a + r.durationMs, 0);
  console.log(`\nTotal wall time: ${totalMs}ms`);
}

main().catch((e) => { console.error(e); process.exit(1); });
