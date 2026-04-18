import { loadConfigFromFile } from "./src/config/load.ts";
import { createAdapterRegistry } from "./src/core/registry.ts";
import { createListService } from "./src/core/list.ts";
import { createOpenCodeAdapter } from "./src/adapters/opencode.ts";
import { createCodexAdapter } from "./src/adapters/codex.ts";

const config = loadConfigFromFile("./oas.config.yaml");
console.error("Config loaded:", config.agents.map(a => a.agent + ":" + a.alias));

const cwd = process.cwd();
const registry = createAdapterRegistry(config, {
  opencode: (e: any) => createOpenCodeAdapter(e, { cwd }),
  codex: (e: any) => createCodexAdapter(e, {}),
});
console.error("Registry created, adapters:", registry.adapters.map(a => a.alias));

const listService = createListService(registry);
console.error("ListService created");

const LIST_TIMEOUT_MS = 8000;
const t0 = Date.now();

const promise = Promise.race([
  listService({ limit: 50 }),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("List timed out after " + LIST_TIMEOUT_MS + "ms")), LIST_TIMEOUT_MS)
  ),
]);

promise.then(result => {
  console.error("List succeeded after " + (Date.now()-t0) + "ms: " + result.sessions.length + " sessions, " + result.errors.length + " errors");
  for (const e of result.errors) {
    console.error("  ERROR [" + e.agent + ":" + e.alias + "]: " + e.message);
  }
  process.exit(0);
}).catch(err => {
  console.error("List failed after " + (Date.now()-t0) + "ms: " + err.message);
  process.exit(1);
});
