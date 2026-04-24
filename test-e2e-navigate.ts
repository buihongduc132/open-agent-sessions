import { createRegistry } from "./src/core/registry";
import { createGeminiAdapter } from "./src/adapters/gemini";
import { createAntigravityAdapter } from "./src/adapters/antigravity";
import { Config, OtherAgentEntry } from "./src/config/types";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { safeStat } from "./src/adapters/fs-utils";
import { searchSessions } from "./src/core/search";
import { listSessions } from "./src/core/list";

async function main() {
  const home = homedir();
  const geminiProjects = readdirSync(join(home, ".gemini", "tmp")).filter(d => 
    safeStat(join(home, ".gemini", "tmp", d, "chats"))?.isDirectory()
  );

  const config: Config = {
    agents: [
      ...geminiProjects.map(p => ({
        agent: "gemini",
        alias: `gemini-${p}`,
        enabled: true,
        path: join(home, ".gemini", "tmp", p),
      } as OtherAgentEntry)),
      {
        agent: "antigravity",
        alias: "ag-local",
        enabled: true,
        path: join(home, ".gemini", "antigravity"),
      } as OtherAgentEntry,
    ],
  };

  const factories = {
    gemini: (entry: any) => createGeminiAdapter(entry),
    antigravity: (entry: any) => createAntigravityAdapter(entry),
  };

  const registry = createRegistry(config, factories);

  console.log("=== Scenario 1: Full Discovery ===");
  const allSessions = await listSessions(registry, {});
  console.log(`Found ${allSessions.sessions.length} total sessions.`);
  const agents = new Set(allSessions.sessions.map(s => s.agent));
  console.log(`Agents found: ${Array.from(agents).join(", ")}`);

  console.log("\n=== Scenario 2: Agent Filtering (Gemini) ===");
  const geminiSessions = await listSessions(registry, { agent: "gemini" });
  console.log(`Found ${geminiSessions.sessions.length} Gemini sessions.`);

  console.log("\n=== Scenario 3: Global Search ('gemini') ===");
  const searchResult = await searchSessions(registry, { text: "gemini" });
  console.log(`Found ${searchResult.length} sessions matching 'gemini'.`);
  if (searchResult.length > 0) {
    console.log(`Top match: ${searchResult[0].title} [${searchResult[0].agent}]`);
  }

  console.log("\n=== Scenario 4: Targeted Search (Antigravity 'E2E') ===");
  const agSearch = await searchSessions(registry, { text: "E2E", agent: "antigravity" });
  console.log(`Found ${agSearch.length} Antigravity sessions matching 'E2E'.`);

  console.log("\n=== Scenario 5: Navigation (Gemini Detail) ===");
  if (geminiSessions.sessions.length > 0) {
    const s = geminiSessions.sessions[0];
    const handle = registry.adapters.find(h => h.alias === s.alias);
    const detail = await handle?.getSessionDetail!(s.id, {});
    console.log(`Session: ${s.title} (${s.id})`);
    console.log(`Messages: ${detail?.messages?.length}`);
  }

  console.log("\n=== Scenario 6: Navigation (Antigravity Detail) ===");
  const agSessions = await listSessions(registry, { agent: "antigravity" });
  if (agSessions.sessions.length > 0) {
    const s = agSessions.sessions.find(s => s.message_count > 0) || agSessions.sessions[0];
    const handle = registry.adapters.find(h => h.alias === s.alias);
    const detail = await handle?.getSessionDetail!(s.id, {});
    console.log(`Session: ${s.title} (${s.id})`);
    console.log(`Messages: ${detail?.messages?.length}`);
  }

  console.log("\n=== Scenario 7: Message Selection (Last 3) ===");
  if (agSessions.sessions.length > 0) {
    const s = agSessions.sessions.find(s => s.message_count > 3) || agSessions.sessions[0];
    const handle = registry.adapters.find(h => h.alias === s.alias);
    const last3 = await handle?.getSessionDetail!(s.id, { selection: { mode: "last", count: 3 } });
    console.log(`Selection count: ${last3?.messages?.length}`);
  }

  console.log("\n=== Scenario 8: Tool Search (Antigravity 'run_command') ===");
  // Note: core search doesn't support tool search yet? Let's check detail.
  const agWithTools = [];
  for (const s of agSessions.sessions.slice(0, 5)) {
    const handle = registry.adapters.find(h => h.alias === s.alias);
    const detail = await handle?.getSessionDetail!(s.id, {});
    const hasRunCommand = detail?.messages?.some(m => m.parts.some(p => p.type === "tool" && p.tool === "run_command"));
    if (hasRunCommand) agWithTools.push(s);
  }
  console.log(`Found ${agWithTools.length} Antigravity sessions (in first 5) using 'run_command'.`);

  console.log("\n=== Scenario 9: Title Verification ===");
  const geminiWithTitle = geminiSessions.sessions.filter(s => s.title !== s.id);
  console.log(`Gemini sessions with custom titles: ${geminiWithTitle.length}/${geminiSessions.sessions.length}`);

  console.log("\n=== Scenario 10: Timestamp Sorting ===");
  const top3 = allSessions.sessions.slice(0, 3);
  console.log("Top 3 most recent sessions:");
  top3.forEach(s => console.log(`- ${s.updated_at} [${s.agent}] ${s.title}`));

  console.log("\n=== Scenario 11: Most Recent (Per Agent) ===");
  const latestGemini = geminiSessions.sessions[0];
  const latestAg = agSessions.sessions[0];
  console.log(`Latest Gemini: ${latestGemini?.updated_at} - ${latestGemini?.title}`);
  console.log(`Latest Antigravity: ${latestAg?.updated_at} - ${latestAg?.title}`);

  console.log("\n=== Scenario 12: Cross-Repo Discovery ===");
  // Search for the same title in other projects
  if (latestGemini) {
    const title = latestGemini.title;
    const crossSearch = await searchSessions(registry, { text: title });
    const otherProjects = new Set(crossSearch.map(s => s.alias));
    console.log(`Sessions with title "${title}" found in aliases: ${Array.from(otherProjects).join(", ")}`);
  }
}

main().catch(console.error);
