import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// ../../src/core/normalize.ts
var ALLOWED_AGENTS = ["opencode", "codex", "claude", "hermes", "gemini", "antigravity", "pi", "zcode"];
var ALLOWED_STORAGE = ["db", "jsonl", "other"];
function normalizeSessionSummary(input, context = "SessionSummary") {
  if (!isPlainObject(input)) {
    throw new Error(`${context}: session summary must be a mapping, got ${typeName(input)}`);
  }
  const record = input;
  const id = record.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(`${context}: id must be a non-empty string`);
  }
  const agent = record.agent;
  if (typeof agent !== "string" || !ALLOWED_AGENTS.includes(agent)) {
    throw new Error(`${context}: agent must be one of ${ALLOWED_AGENTS.join(", ")}, got ${stringifyValue(agent)}`);
  }
  const alias = record.alias;
  if (typeof alias !== "string") {
    throw new Error(`${context}: alias must be a string`);
  }
  const title = record.title;
  if (typeof title !== "string") {
    throw new Error(`${context}: title must be a string`);
  }
  const createdAt = normalizeTimestamp(record.created_at, `${context}: created_at`);
  const updatedAt = normalizeTimestamp(record.updated_at, `${context}: updated_at`);
  const messageCount = record.message_count;
  if (!Number.isInteger(messageCount) || messageCount < 0) {
    throw new Error(`${context}: message_count must be a non-negative integer`);
  }
  const storage = record.storage;
  if (typeof storage !== "string" || !ALLOWED_STORAGE.includes(storage)) {
    throw new Error(`${context}: storage must be one of ${ALLOWED_STORAGE.join(", ")}, got ${stringifyValue(storage)}`);
  }
  const parentSessionIdRaw = record.parentSessionId;
  const summary = {
    id,
    agent,
    alias,
    title,
    created_at: createdAt,
    updated_at: updatedAt,
    message_count: messageCount,
    storage
  };
  if (parentSessionIdRaw !== undefined && parentSessionIdRaw !== null) {
    if (typeof parentSessionIdRaw !== "string" || parentSessionIdRaw.length === 0) {
      throw new Error(`${context}: parentSessionId must be a non-empty string`);
    }
    summary.parentSessionId = parentSessionIdRaw;
  }
  return summary;
}
function normalizeTimestamp(value, context) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`${context} must be a valid timestamp`);
    }
    return value.toISOString();
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`${context} must be a valid timestamp`);
    }
    return date.toISOString();
  }
  throw new Error(`${context} must be a valid timestamp`);
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function typeName(value) {
  if (value === null)
    return "null";
  if (Array.isArray(value))
    return "list";
  return typeof value;
}
function stringifyValue(value) {
  if (typeof value === "string")
    return `"${value}"`;
  if (value === null)
    return "null";
  return String(value);
}

// ../../src/core/utils.ts
function errorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

// ../../node_modules/quick-lru/index.js
class QuickLRU extends Map {
  #size = 0;
  #cache = new Map;
  #oldCache = new Map;
  #maxSize;
  #maxAge;
  #onEviction;
  constructor(options = {}) {
    super();
    if (!(options.maxSize && options.maxSize > 0)) {
      throw new TypeError("`maxSize` must be a number greater than 0");
    }
    if (typeof options.maxAge === "number" && options.maxAge === 0) {
      throw new TypeError("`maxAge` must be a number greater than 0");
    }
    this.#maxSize = options.maxSize;
    this.#maxAge = options.maxAge || Number.POSITIVE_INFINITY;
    this.#onEviction = options.onEviction;
  }
  get __oldCache() {
    return this.#oldCache;
  }
  #emitEvictions(cache) {
    if (typeof this.#onEviction !== "function") {
      return;
    }
    for (const [key, item] of cache) {
      this.#onEviction(key, item.value);
    }
  }
  #deleteIfExpired(key, item) {
    if (typeof item.expiry === "number" && item.expiry <= Date.now()) {
      if (typeof this.#onEviction === "function") {
        this.#onEviction(key, item.value);
      }
      return this.delete(key);
    }
    return false;
  }
  #getOrDeleteIfExpired(key, item) {
    const deleted = this.#deleteIfExpired(key, item);
    if (deleted === false) {
      return item.value;
    }
  }
  #getItemValue(key, item) {
    return item.expiry ? this.#getOrDeleteIfExpired(key, item) : item.value;
  }
  #peek(key, cache) {
    const item = cache.get(key);
    return this.#getItemValue(key, item);
  }
  #set(key, value) {
    this.#cache.set(key, value);
    this.#size++;
    if (this.#size >= this.#maxSize) {
      this.#size = 0;
      this.#emitEvictions(this.#oldCache);
      this.#oldCache = this.#cache;
      this.#cache = new Map;
    }
  }
  #moveToRecent(key, item) {
    this.#oldCache.delete(key);
    this.#set(key, item);
  }
  *#entriesAscending() {
    for (const item of this.#oldCache) {
      const [key, value] = item;
      if (!this.#cache.has(key)) {
        const deleted = this.#deleteIfExpired(key, value);
        if (deleted === false) {
          yield item;
        }
      }
    }
    for (const item of this.#cache) {
      const [key, value] = item;
      const deleted = this.#deleteIfExpired(key, value);
      if (deleted === false) {
        yield item;
      }
    }
  }
  get(key) {
    if (this.#cache.has(key)) {
      const item = this.#cache.get(key);
      return this.#getItemValue(key, item);
    }
    if (this.#oldCache.has(key)) {
      const item = this.#oldCache.get(key);
      if (this.#deleteIfExpired(key, item) === false) {
        this.#moveToRecent(key, item);
        return item.value;
      }
    }
  }
  set(key, value, { maxAge = this.#maxAge } = {}) {
    const expiry = typeof maxAge === "number" && maxAge !== Number.POSITIVE_INFINITY ? Date.now() + maxAge : undefined;
    if (this.#cache.has(key)) {
      this.#cache.set(key, {
        value,
        expiry
      });
    } else {
      this.#set(key, { value, expiry });
    }
    return this;
  }
  has(key) {
    if (this.#cache.has(key)) {
      return !this.#deleteIfExpired(key, this.#cache.get(key));
    }
    if (this.#oldCache.has(key)) {
      return !this.#deleteIfExpired(key, this.#oldCache.get(key));
    }
    return false;
  }
  peek(key) {
    if (this.#cache.has(key)) {
      return this.#peek(key, this.#cache);
    }
    if (this.#oldCache.has(key)) {
      return this.#peek(key, this.#oldCache);
    }
  }
  expiresIn(key) {
    const item = this.#cache.get(key) ?? this.#oldCache.get(key);
    if (item) {
      return item.expiry ? item.expiry - Date.now() : Number.POSITIVE_INFINITY;
    }
  }
  delete(key) {
    const deleted = this.#cache.delete(key);
    if (deleted) {
      this.#size--;
    }
    return this.#oldCache.delete(key) || deleted;
  }
  clear() {
    this.#cache.clear();
    this.#oldCache.clear();
    this.#size = 0;
  }
  resize(newSize) {
    if (!(newSize && newSize > 0)) {
      throw new TypeError("`maxSize` must be a number greater than 0");
    }
    const items = [...this.#entriesAscending()];
    const removeCount = items.length - newSize;
    if (removeCount < 0) {
      this.#cache = new Map(items);
      this.#oldCache = new Map;
      this.#size = items.length;
    } else {
      if (removeCount > 0) {
        this.#emitEvictions(items.slice(0, removeCount));
      }
      this.#oldCache = new Map(items.slice(removeCount));
      this.#cache = new Map;
      this.#size = 0;
    }
    this.#maxSize = newSize;
  }
  evict(count = 1) {
    const requested = Number(count);
    if (!requested || requested <= 0) {
      return;
    }
    const items = [...this.#entriesAscending()];
    const evictCount = Math.trunc(Math.min(requested, Math.max(items.length - 1, 0)));
    if (evictCount <= 0) {
      return;
    }
    this.#emitEvictions(items.slice(0, evictCount));
    this.#oldCache = new Map(items.slice(evictCount));
    this.#cache = new Map;
    this.#size = 0;
  }
  *keys() {
    for (const [key] of this) {
      yield key;
    }
  }
  *values() {
    for (const [, value] of this) {
      yield value;
    }
  }
  *[Symbol.iterator]() {
    for (const item of this.#cache) {
      const [key, value] = item;
      const deleted = this.#deleteIfExpired(key, value);
      if (deleted === false) {
        yield [key, value.value];
      }
    }
    for (const item of this.#oldCache) {
      const [key, value] = item;
      if (!this.#cache.has(key)) {
        const deleted = this.#deleteIfExpired(key, value);
        if (deleted === false) {
          yield [key, value.value];
        }
      }
    }
  }
  *entriesDescending() {
    let items = [...this.#cache];
    for (let i = items.length - 1;i >= 0; --i) {
      const item = items[i];
      const [key, value] = item;
      const deleted = this.#deleteIfExpired(key, value);
      if (deleted === false) {
        yield [key, value.value];
      }
    }
    items = [...this.#oldCache];
    for (let i = items.length - 1;i >= 0; --i) {
      const item = items[i];
      const [key, value] = item;
      if (!this.#cache.has(key)) {
        const deleted = this.#deleteIfExpired(key, value);
        if (deleted === false) {
          yield [key, value.value];
        }
      }
    }
  }
  *entriesAscending() {
    for (const [key, value] of this.#entriesAscending()) {
      yield [key, value.value];
    }
  }
  get size() {
    if (!this.#size) {
      return this.#oldCache.size;
    }
    let oldCacheSize = 0;
    for (const key of this.#oldCache.keys()) {
      if (!this.#cache.has(key)) {
        oldCacheSize++;
      }
    }
    return Math.min(this.#size + oldCacheSize, this.#maxSize);
  }
  get maxSize() {
    return this.#maxSize;
  }
  get maxAge() {
    return this.#maxAge;
  }
  entries() {
    return this.entriesAscending();
  }
  forEach(callbackFunction, thisArgument = this) {
    for (const [key, value] of this.entriesAscending()) {
      callbackFunction.call(thisArgument, value, key, this);
    }
  }
  get [Symbol.toStringTag]() {
    return "QuickLRU";
  }
  toString() {
    return `QuickLRU(${this.size}/${this.maxSize})`;
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return this.toString();
  }
}

// ../../src/core/constants.ts
var AGENT_ORDER = {
  opencode: 0,
  codex: 1,
  claude: 2,
  hermes: 3,
  gemini: 4,
  antigravity: 5,
  pi: 6,
  zcode: 7
};
var SUPPORTED_AGENTS = Object.keys(AGENT_ORDER);

// ../../src/core/list.ts
var listCache = new QuickLRU({ maxSize: 20, maxAge: 30000 });
function clearListCache() {
  listCache.clear();
}
var _encoder = new TextEncoder;
var _decoder = new TextDecoder;

// ../../src/core/registry.ts
var detailCache = new QuickLRU({ maxSize: 50 });
function clearDetailCache() {
  detailCache.clear();
  clearListCache();
}
function invalidateDetailCache(alias, sessionId) {
  const prefix = `${alias}:${sessionId}:`;
  for (const key of detailCache.keys()) {
    if (key.startsWith(prefix)) {
      detailCache.delete(key);
    }
  }
  clearListCache();
}
function createAdapterRegistry(config, factories) {
  const entries = config.agents ?? [];
  ensureUniqueAliases(entries);
  const enabledEntries = entries.filter((entry) => entry.enabled);
  const sorted = enabledEntries.slice().sort(compareEntries);
  const adapters = sorted.map((entry) => buildHandle(entry, factories, entries.indexOf(entry)));
  return { adapters };
}
function createRegistry(config, factories) {
  return createAdapterRegistry(config, factories);
}
function createAdapter(entry, factories) {
  const factory = factories[entry.agent];
  if (!factory)
    return null;
  return factory(entry);
}
function ensureUniqueAliases(entries) {
  const seen = new Map;
  entries.forEach((entry, index) => {
    if (seen.has(entry.alias)) {
      const firstIndex = seen.get(entry.alias);
      const context = formatAdapterLabel(entry);
      throw new Error(`${context} duplicate alias "${entry.alias}" (first seen at agents[${firstIndex}])`);
    }
    seen.set(entry.alias, index);
  });
}
function compareEntries(a, b) {
  const agentDelta = AGENT_ORDER[a.agent] - AGENT_ORDER[b.agent];
  if (agentDelta !== 0)
    return agentDelta;
  return a.alias.localeCompare(b.alias);
}
function buildHandle(entry, factories, index) {
  const context = formatAdapterLabel(entry);
  const validationContext = formatValidationContext(entry, index);
  const factory = factories[entry.agent];
  if (!factory) {
    throw new Error(`${context} adapter factory not found for agent "${entry.agent}"`);
  }
  let adapter;
  try {
    adapter = factory(entry);
  } catch (error) {
    throw new Error(`${context} ${errorMessage(error)}`);
  }
  const cacheKey = (sessionId, options) => `${entry.alias}:${sessionId}:${JSON.stringify(options ?? {})}`;
  return {
    agent: entry.agent,
    alias: entry.alias,
    version: adapter.version,
    listSessions: async () => {
      let sessions;
      try {
        sessions = await adapter.listSessions();
      } catch (error) {
        throw new Error(`${context} ${errorMessage(error)}`);
      }
      if (!Array.isArray(sessions)) {
        throw new Error(`${validationContext} adapter returned non-list sessions`);
      }
      return sessions.map((session, sessionIndex) => {
        const normalized = normalizeSessionSummary(session, `${validationContext} session[${sessionIndex}]`);
        if (normalized.agent !== entry.agent) {
          throw new Error(`${validationContext} session[${sessionIndex}] agent must be "${entry.agent}"`);
        }
        if (normalized.alias !== entry.alias) {
          throw new Error(`${validationContext} session[${sessionIndex}] alias must be "${entry.alias}"`);
        }
        return normalized;
      });
    },
    searchSessions: adapter.searchSessions ? async (query) => adapter.searchSessions(query) : undefined,
    getSessionDetail: adapter.getSessionDetail ? async (sessionId, options) => {
      const key = cacheKey(sessionId, options);
      const cached = detailCache.get(key);
      if (cached) {
        return cached;
      }
      const detail = await adapter.getSessionDetail(sessionId, options ?? {});
      detailCache.set(key, detail);
      return detail;
    } : undefined
  };
}
function formatAdapterLabel(entry) {
  return `[${entry.agent}:${entry.alias}]`;
}
function formatValidationContext(entry, index) {
  const prefix = typeof index === "number" ? `agents[${index}]` : "agent";
  return `${prefix} (${entry.agent}:${entry.alias})`;
}
// ../../src/sdk/workspace.ts
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
var VALID_AGENTS = ["opencode", "codex", "claude", "hermes", "gemini", "antigravity", "pi", "zcode"];
var sessionCache = new Map;
var adapterCache = new Map;
var sharedRegistry = { adapters: [] };
var factories = {};
function setWorkspaceFactories(f) {
  factories = f;
}
function createWorkspaceSession(config) {
  if (!VALID_AGENTS.includes(config.agent)) {
    throw new Error(`createWorkspaceSession: agent must be one of ${VALID_AGENTS.join(", ")}, got "${config.agent}"`);
  }
  const scope = resolveScope(config.scope, config._existsSyncFn);
  const alias = buildCanonicalAlias(config.agent, scope, config.name);
  const cached = sessionCache.get(alias);
  if (cached)
    return cached;
  ensureAdapterRegistered(config.agent, scope, config.storage);
  const adapter = getOrCreateAdapter(config.agent, scope, config.storage);
  const sessionId = randomUUID();
  const sessionRef = {
    agent: config.agent,
    alias,
    sessionId
  };
  const session = {
    registry: sharedRegistry,
    sessionRef,
    adapter,
    scope
  };
  sessionCache.set(alias, session);
  return session;
}
function resolveScope(given, existsSyncFn) {
  if (given !== undefined) {
    if (!isAbsolute(given)) {
      throw new Error(`resolveScope: scope must be an absolute path, got "${given}"`);
    }
    return resolve(given);
  }
  const cwd = process.cwd();
  const gitRoot = findGitRoot(cwd, existsSyncFn);
  return gitRoot ?? cwd;
}
function findGitRoot(startDir, existsSyncFn) {
  const existsSync = existsSyncFn ?? _realExistsSync;
  let current = resolve(startDir);
  const root = resolve("/");
  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    if (current === root)
      break;
    const parent = dirname(current);
    if (parent === current)
      break;
    current = parent;
  }
  return null;
}
var { existsSync: _realExistsSync } = await import("node:fs");
function buildCanonicalAlias(agent, scope, name) {
  if (name) {
    return `${agent}:${scope}:${name}`;
  }
  return `${agent}:${scope}`;
}
function ensureAdapterRegistered(agent, scope, _storage) {
  const alias = `${agent}:${scope}`;
  const alreadyRegistered = sharedRegistry.adapters.some((h) => h.agent === agent && h.alias === alias);
  if (alreadyRegistered)
    return;
  const adapter = getOrCreateAdapter(agent, scope, _storage);
  const handle = buildHandle2(agent, alias, adapter);
  sharedRegistry.adapters.push(handle);
}
function getOrCreateAdapter(agent, scope, _storage) {
  const cacheKey = `${agent}:${scope}`;
  const cached = adapterCache.get(cacheKey);
  if (cached)
    return cached;
  const adapter = instantiateAdapter(agent, scope, _storage);
  adapterCache.set(cacheKey, adapter);
  return adapter;
}
function instantiateAdapter(agent, _scope, _storage) {
  const factory = factories[agent];
  if (!factory) {
    return {
      version: "0.0.0-stub",
      listSessions: () => []
    };
  }
  const alias = `${agent}:${_scope}`;
  const entry = buildAgentEntry(agent, alias, _storage);
  const adapter = createAdapter(entry, factories);
  if (!adapter) {
    throw new Error(`createWorkspaceSession: adapter factory for "${agent}" returned null`);
  }
  return adapter;
}
function buildAgentEntry(agent, alias, storage) {
  if (agent === "opencode") {
    return {
      agent: "opencode",
      alias,
      enabled: true,
      storage: {
        mode: storage?.mode ?? "auto",
        db_path: storage?.db_path,
        jsonl_path: storage?.jsonl_path
      }
    };
  }
  return {
    agent,
    alias,
    enabled: true
  };
}
function buildHandle2(agent, alias, adapter) {
  return {
    agent,
    alias,
    version: adapter.version,
    listSessions: async () => {
      try {
        const sessions = adapter.listSessions();
        return sessions;
      } catch (error) {
        throw new Error(`[${agent}:${alias}] listSessions: ${errorMessage(error)}`);
      }
    }
  };
}
// ../../src/config/load.ts
import { readFileSync as readFileSync2, statSync as statSync2 } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname as dirname2, isAbsolute as isAbsolute3, resolve as resolve3 } from "node:path";

// ../../src/config/validate.ts
var ALLOWED_AGENTS2 = SUPPORTED_AGENTS;
var STORAGE_MODES = ["auto", "db", "jsonl"];
function validateConfig(raw) {
  if (raw === null || raw === undefined) {
    return { agents: [] };
  }
  if (!isPlainObject2(raw)) {
    throw new Error(`Config validation error: top-level must be a mapping, got ${typeName2(raw)}`);
  }
  const agentsRaw = raw.agents;
  if (agentsRaw === undefined) {
    return { agents: [] };
  }
  if (!Array.isArray(agentsRaw)) {
    throw new Error(`Config validation error: "agents" must be a list, got ${typeName2(agentsRaw)}`);
  }
  const entries = [];
  const seenAliases = new Map;
  for (let index = 0;index < agentsRaw.length; index += 1) {
    const entry = validateAgentEntry(agentsRaw[index], index);
    if (seenAliases.has(entry.alias)) {
      const firstIndex = seenAliases.get(entry.alias);
      const context = entryContext(index, entry.agent, entry.alias);
      throw new Error(`${context}: duplicate alias "${entry.alias}" (first seen at agents[${firstIndex}])`);
    }
    seenAliases.set(entry.alias, index);
    entries.push(entry);
  }
  const sorted = entries.slice().sort((a, b) => {
    const agentDelta = AGENT_ORDER[a.agent] - AGENT_ORDER[b.agent];
    if (agentDelta !== 0)
      return agentDelta;
    return a.alias.localeCompare(b.alias);
  });
  return { agents: sorted };
}
function validateAgentEntry(raw, index) {
  if (!isPlainObject2(raw)) {
    const context2 = entryContext(index);
    throw new Error(`${context2}: agent entry must be a mapping, got ${typeName2(raw)}`);
  }
  const record = raw;
  const rawAgent = record.agent;
  const rawAlias = record.alias;
  const context = entryContext(index, rawAgent, rawAlias);
  if (typeof rawAgent !== "string" || !ALLOWED_AGENTS2.includes(rawAgent)) {
    throw new Error(`${context}: agent must be one of ${ALLOWED_AGENTS2.join(", ")}, got ${stringifyValue2(rawAgent)}`);
  }
  const agent = rawAgent;
  if (typeof rawAlias !== "string") {
    throw new Error(`${context}: alias must be a non-empty string`);
  }
  if (rawAlias.trim() !== rawAlias || rawAlias.length === 0) {
    throw new Error(`${context}: alias must be non-empty with no leading/trailing whitespace`);
  }
  const alias = rawAlias;
  let enabled = true;
  if (Object.prototype.hasOwnProperty.call(record, "enabled")) {
    if (typeof record.enabled !== "boolean") {
      throw new Error(`${context}: enabled must be a boolean, got ${typeName2(record.enabled)}`);
    }
    enabled = record.enabled;
  }
  const normalized = { ...record, agent, alias, enabled };
  if (agent === "opencode") {
    normalized.storage = validateOpenCodeStorage(record.storage, context);
  }
  return normalized;
}
function validateOpenCodeStorage(raw, context) {
  if (raw === undefined) {
    return { mode: "auto" };
  }
  if (!isPlainObject2(raw)) {
    throw new Error(`${context}: storage must be a mapping`);
  }
  const record = raw;
  const modeRaw = record.mode ?? "auto";
  if (typeof modeRaw !== "string" || !STORAGE_MODES.includes(modeRaw)) {
    throw new Error(`${context}: storage.mode must be one of ${STORAGE_MODES.join(", ")}, got ${stringifyValue2(modeRaw)}`);
  }
  const dbPath = record.db_path;
  if (dbPath !== undefined) {
    if (typeof dbPath !== "string" || dbPath.trim().length === 0) {
      throw new Error(`${context}: storage.db_path must be a non-empty string`);
    }
  }
  const jsonlPath = record.jsonl_path;
  if (jsonlPath !== undefined) {
    if (typeof jsonlPath !== "string" || jsonlPath.trim().length === 0) {
      throw new Error(`${context}: storage.jsonl_path must be a non-empty string`);
    }
  }
  return {
    mode: modeRaw,
    db_path: dbPath,
    jsonl_path: jsonlPath
  };
}
function entryContext(index, agent, alias) {
  let context = `agents[${index}]`;
  const agentPart = typeof agent === "string" ? agent : undefined;
  const aliasPart = typeof alias === "string" ? alias : undefined;
  if (agentPart || aliasPart) {
    const labelParts = [agentPart, aliasPart].filter(Boolean);
    context += ` (${labelParts.join(":")})`;
  }
  return context;
}
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function typeName2(value) {
  if (value === null)
    return "null";
  if (Array.isArray(value))
    return "list";
  return typeof value;
}
function stringifyValue2(value) {
  if (typeof value === "string")
    return `"${value}"`;
  if (value === null)
    return "null";
  return String(value);
}

// ../../src/adapters/fs-utils.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute as isAbsolute2, join as join2, resolve as resolve2 } from "node:path";
function resolvePath(pathValue, baseDir) {
  const expanded = expandTilde(pathValue);
  if (isAbsolute2(expanded)) {
    return expanded;
  }
  const base = baseDir ?? process.cwd();
  return resolve2(base, expanded);
}
function expandTilde(pathValue) {
  if (pathValue === "~") {
    return homedir();
  }
  if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) {
    return join2(homedir(), pathValue.slice(2));
  }
  return pathValue;
}
function safeStat(pathValue) {
  try {
    return statSync(pathValue);
  } catch {
    return null;
  }
}
function collectJsonlFiles(rootPath) {
  const stat = statSync(rootPath);
  if (stat.isFile()) {
    return [rootPath];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const files = [];
  walkDir(rootPath, files);
  return files.sort((a, b) => a.localeCompare(b));
}
function walkDir(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join2(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
}
function splitJsonlLines(content) {
  return content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}
function contentContains(filePath, needle) {
  try {
    return readFileSync(filePath, "utf8").toLowerCase().includes(needle);
  } catch {
    return false;
  }
}
function listJsonFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join2(dir, f));
  } catch {
    return [];
  }
}
function containsIgnoreCase(text, needle) {
  return text.toLowerCase().includes(needle.toLowerCase());
}
function minIso(a, b) {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}
function maxIso(a, b) {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}
function sortByIsoDesc(arr, key) {
  return [...arr].sort((a, b) => {
    const aVal = String(a[key] ?? "");
    const bVal = String(b[key] ?? "");
    return Date.parse(bVal) - Date.parse(aVal);
  });
}
function readTextFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ../../src/config/load.ts
class YamlParseError extends Error {
  line;
  column;
  constructor(message) {
    super(message);
    this.name = "YamlParseError";
  }
}
function loadConfigFromFile(path) {
  if (!path || typeof path !== "string") {
    throw new Error("Config path must be a non-empty string");
  }
  let stat;
  try {
    stat = statSync2(path);
  } catch (error) {
    throw new Error(`Config file not found or unreadable: ${path}`);
  }
  if (stat.isDirectory()) {
    throw new Error(`Config path is a directory: ${path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Config path is not a file: ${path}`);
  }
  let contents;
  try {
    contents = readFileSync2(path, "utf8");
  } catch (error) {
    throw new Error(`Config file unreadable: ${path}`);
  }
  const config = parseConfigText(contents, path);
  return resolveAgentPaths(config, dirname2(path));
}
function parseConfigText(contents, sourcePath = "<config>") {
  if (contents.trim().length === 0) {
    return { agents: [] };
  }
  let data;
  try {
    data = parseYamlWithPython(contents, sourcePath);
  } catch (error) {
    throw new Error(formatYamlError(error, sourcePath));
  }
  if (data === null) {
    return { agents: [] };
  }
  return validateConfig(data);
}
function resolveAgentPaths(config, baseDir) {
  const agents = config.agents.map((entry) => {
    if (entry.agent === "opencode") {
      return entry;
    }
    const record = entry;
    const pathValue = record.path;
    if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
      return entry;
    }
    const resolved = resolvePath2(pathValue, baseDir);
    return { ...record, path: resolved };
  });
  return { agents };
}
function resolvePath2(pathValue, baseDir) {
  const expanded = expandTilde(pathValue);
  if (isAbsolute3(expanded)) {
    return expanded;
  }
  return resolve3(baseDir, expanded);
}
function parseYamlWithPython(contents, sourcePath) {
  const script = String.raw`import sys
import json
import yaml
from yaml.loader import SafeLoader

class UniqueKeyLoader(SafeLoader):
    pass

def construct_mapping(loader, node, deep=False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.constructor.ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                f"duplicate key: {key}",
                key_node.start_mark,
            )
        value = loader.construct_object(value_node, deep=deep)
        mapping[key] = value
    return mapping

UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    construct_mapping,
)

text = sys.stdin.read()
try:
    data = yaml.load(text, Loader=UniqueKeyLoader)
    json.dump({"ok": True, "data": data}, sys.stdout)
except yaml.YAMLError as e:
    mark = getattr(e, "problem_mark", None)
    line = getattr(mark, "line", None)
    column = getattr(mark, "column", None)
    msg = str(e)
    json.dump({"ok": False, "message": msg, "line": line, "column": column}, sys.stdout)
`;
  const result = spawnSync("python3", ["-c", script], {
    input: contents,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024
  });
  if (result.error) {
    throw new Error(`YAML parse error in ${sourcePath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    throw new Error(stderr ? `YAML parse error in ${sourcePath}: ${stderr}` : `YAML parse error in ${sourcePath}`);
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(`YAML parse error in ${sourcePath}: unable to parse parser output`);
  }
  if (!payload.ok) {
    const err = new YamlParseError(payload.message ?? "YAML parse error");
    err.line = payload.line ?? undefined;
    err.column = payload.column ?? undefined;
    throw err;
  }
  return payload.data ?? null;
}
function formatYamlError(error, sourcePath) {
  if (!error || typeof error !== "object") {
    return `YAML parse error in ${sourcePath}`;
  }
  const record = error;
  const message = typeof record.message === "string" ? record.message : String(error);
  const line = typeof record.line === "number" ? record.line + 1 : undefined;
  const column = typeof record.column === "number" ? record.column + 1 : undefined;
  if (line !== undefined && column !== undefined) {
    return `YAML parse error in ${sourcePath} at line ${line}, column ${column}: ${message}`;
  }
  return `YAML parse error in ${sourcePath}: ${message}`;
}
// ../../src/adapters/opencode.ts
import { existsSync as existsSync2, readFileSync as readFileSync3, statSync as statSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname3, join as join3, resolve as resolve4 } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";

// ../../src/config/opencode.ts
import { existsSync } from "node:fs";
function resolveOpenCodeStorage(entry, defaults, options = {}) {
  const exists = options.exists ?? existsSync;
  const contextPrefix = options.context ? `${options.context}: ` : "";
  const dbPath = entry.storage.db_path ?? defaults.dbPath;
  const jsonlPath = entry.storage.jsonl_path ?? defaults.jsonlPath;
  const dbExists = exists(dbPath);
  const jsonlExists = exists(jsonlPath);
  switch (entry.storage.mode) {
    case "auto":
      if (dbExists) {
        return { mode: "db", path: dbPath, dbPath, jsonlPath };
      }
      if (jsonlExists) {
        return { mode: "jsonl", path: jsonlPath, dbPath, jsonlPath };
      }
      throw new Error(`${contextPrefix}OpenCode storage not found (db: ${dbPath}, jsonl: ${jsonlPath})`);
    case "db":
      if (!dbExists) {
        throw new Error(`${contextPrefix}OpenCode DB not found: ${dbPath}`);
      }
      return { mode: "db", path: dbPath, dbPath, jsonlPath };
    case "jsonl":
      if (!jsonlExists) {
        throw new Error(`${contextPrefix}OpenCode JSONL not found: ${jsonlPath}`);
      }
      return { mode: "jsonl", path: jsonlPath, dbPath, jsonlPath };
    default:
      throw new Error(`${contextPrefix}Unsupported storage mode: ${entry.storage.mode}`);
  }
}

// ../../src/similarity/config.ts
function initializeSimilarity(db, cfg) {
  if (!cfg.enabled)
    return;
  const dim = cfg.vectorDimension ?? 384;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_vec USING vec0(
        embedding float[${dim}],
        session_id TEXT,
        message_id TEXT,
        chunk_text TEXT
      )
    `);
  } catch (_err) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_vec (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          embedding   TEXT,
          session_id  TEXT,
          message_id  TEXT,
          chunk_text  TEXT
        )
      `);
    } catch {}
  }
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
        session_id,
        message_id,
        chunk_text,
        tokenize='porter unicode61'
      )
    `);
  } catch (_err) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_fts (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id  TEXT,
          message_id  TEXT,
          chunk_text  TEXT
        )
      `);
    } catch {}
  }
}

// ../../src/similarity/storage.ts
function extractChunks(detail) {
  const chunks = [];
  const messages = detail.messages ?? [];
  for (const msg of messages) {
    if (msg.role === "system")
      continue;
    const textParts = msg.parts?.filter((p) => p.type === "text") ?? [];
    if (textParts.length === 0)
      continue;
    const combinedText = textParts.map((p) => p.text).join("").trim();
    if (combinedText.length <= 29)
      continue;
    chunks.push({
      sessionId: detail.id,
      messageId: msg.id,
      chunkText: combinedText,
      role: msg.role
    });
  }
  return chunks;
}
var EMBEDDING_DIM = 384;
function generateEmbedding(text) {
  const embedding = [];
  for (let i = 0;i < EMBEDDING_DIM; i++) {
    const charCode = text.charCodeAt(i % text.length) || 0;
    embedding.push(Math.sin(charCode + i) * 0.5 + 0.5);
  }
  return embedding;
}
function storeEmbeddings(db, records) {
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vec_session_msg
      ON session_vec (session_id, message_id)
    `);
  } catch {}
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO session_vec (embedding, session_id, message_id, chunk_text)
    VALUES (?, ?, ?, ?)
  `);
  for (const record of records) {
    stmt.run(JSON.stringify(record.embedding), record.sessionId, record.messageId, record.chunkText);
  }
}
function getLastIndexedMessageId(db, sessionId) {
  const stmt = db.prepare(`
    SELECT message_id
    FROM session_vec
    WHERE session_id = ?
    ORDER BY rowid DESC
    LIMIT 1
  `);
  const row = stmt.get(sessionId);
  return row?.message_id ?? null;
}
function indexFtsChunks(db, chunks) {
  if (chunks.length === 0)
    return;
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fts_session_msg
      ON session_fts (session_id, message_id)
    `);
  } catch {}
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO session_fts (session_id, message_id, chunk_text)
      VALUES (?, ?, ?)
    `);
    for (const chunk of chunks) {
      stmt.run(chunk.sessionId, chunk.messageId, chunk.chunkText);
    }
  } catch {}
}
function indexSessionEmbeddings(db, detail) {
  const lastIndexed = getLastIndexedMessageId(db, detail.id);
  const allChunks = extractChunks(detail);
  let foundLastIndexed = lastIndexed === null;
  const newChunks = allChunks.filter((chunk) => {
    if (foundLastIndexed)
      return true;
    if (chunk.messageId === lastIndexed) {
      foundLastIndexed = true;
      return true;
    }
    return false;
  });
  if (newChunks.length === 0) {
    return { sessionId: detail.id, lastIndexedMessageId: lastIndexed };
  }
  const records = newChunks.map((chunk) => ({
    sessionId: chunk.sessionId,
    messageId: chunk.messageId,
    chunkText: chunk.chunkText,
    embedding: generateEmbedding(chunk.chunkText)
  }));
  storeEmbeddings(db, records);
  indexFtsChunks(db, newChunks);
  return {
    sessionId: detail.id,
    lastIndexedMessageId: newChunks[newChunks.length - 1]?.messageId ?? lastIndexed
  };
}

// ../../src/similarity/search.ts
var RRF_K_DEFAULT = 60;
var VECTOR_WEIGHT_DEFAULT = 0.7;
var TOP_K_DEFAULT = 5;
var MAX_RANK_FALLBACK = 9999;
async function findSimilarSessions(db, query, options) {
  const topK = options?.topK ?? TOP_K_DEFAULT;
  const rrfK = options?.rrfK ?? RRF_K_DEFAULT;
  const vectorWeight = options?.vectorWeight ?? VECTOR_WEIGHT_DEFAULT;
  const ftsWeight = 1 - vectorWeight;
  if (!tablesExist(db)) {
    return [];
  }
  const queryEmbedding = generateEmbedding(query ?? "");
  const ftsResults = runFtsSearch(db, query, topK * 3);
  const vecResults = runVectorSearch(db, queryEmbedding, topK * 3);
  const fused = applyRrfFusion(ftsResults, vecResults, rrfK, vectorWeight, ftsWeight);
  const ranked = buildResults(db, fused, topK, options?.sessionTitles);
  return ranked;
}
function tablesExist(db) {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name IN ('session_vec', 'session_fts')`).get();
    return row.cnt >= 2;
  } catch {
    return false;
  }
}
function runFtsSearch(db, query, limit) {
  if (!query || query.trim().length === 0)
    return [];
  try {
    const rows = db.prepare(`
        SELECT
          session_id,
          message_id,
          ROW_NUMBER() OVER (ORDER BY bm25(session_fts) ASC) - 1 AS rnk
        FROM session_fts
        WHERE session_fts MATCH ?
        LIMIT ?
        `).all(query.trim(), limit);
    const hits = [];
    rows.forEach((row, idx) => {
      hits.push({ sessionId: row.session_id, messageId: row.message_id, rank: idx });
    });
    return hits;
  } catch {}
  try {
    const pattern = `%${query.trim().replace(/\s+/g, "%")}%`;
    const rows = db.prepare(`
        SELECT session_id, message_id
        FROM session_fts
        WHERE chunk_text LIKE ?
        LIMIT ?
        `).all(pattern, limit);
    return rows.map((row, idx) => ({
      sessionId: row.session_id,
      messageId: row.message_id,
      rank: idx
    }));
  } catch {
    return [];
  }
}
function runVectorSearch(db, queryEmbedding, limit) {
  const hits = [];
  const jsonEmbed = JSON.stringify(queryEmbedding);
  try {
    const rows = db.prepare(`
        SELECT
          session_id,
          message_id,
          distance
        FROM session_vec
        WHERE embedding MATCH ?
        ORDER BY distance ASC
        LIMIT ?
        `).all(jsonEmbed, limit);
    rows.forEach((row, idx) => {
      hits.push({
        sessionId: row.session_id,
        messageId: row.message_id,
        distance: row.distance,
        rank: idx
      });
    });
    return hits;
  } catch {}
  try {
    const allRows = db.prepare(`SELECT embedding, session_id, message_id FROM session_vec`).all();
    const scored = [];
    for (const row of allRows) {
      try {
        const stored = JSON.parse(row.embedding);
        const similarity = cosineSimilarity(queryEmbedding, stored);
        scored.push({
          sessionId: row.session_id,
          messageId: row.message_id,
          distance: 1 - similarity
        });
      } catch {}
    }
    scored.sort((a, b) => a.distance - b.distance);
    for (let i = 0;i < Math.min(limit, scored.length); i++) {
      hits.push({
        sessionId: scored[i].sessionId,
        messageId: scored[i].messageId,
        distance: scored[i].distance,
        rank: i
      });
    }
    return hits;
  } catch {
    return [];
  }
}
function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0;i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const d = Math.sqrt(normA) * Math.sqrt(normB);
  return d === 0 ? 0 : dot / d;
}
function applyRrfFusion(ftsResults, vecResults, rrfK, vecWeight, ftsWeight) {
  const ftsRankMap = new Map;
  for (let i = 0;i < ftsResults.length; i++) {
    if (!ftsRankMap.has(ftsResults[i].sessionId)) {
      ftsRankMap.set(ftsResults[i].sessionId, i);
    }
  }
  const vecRankMap = new Map;
  const vecDistMap = new Map;
  for (let i = 0;i < vecResults.length; i++) {
    if (!vecRankMap.has(vecResults[i].sessionId)) {
      vecRankMap.set(vecResults[i].sessionId, i);
      vecDistMap.set(vecResults[i].sessionId, vecResults[i].distance);
    }
  }
  const allSessionIds = new Set([...ftsRankMap.keys(), ...vecRankMap.keys()]);
  const scored = [];
  for (const sessionId of allSessionIds) {
    const ftsRank = ftsRankMap.get(sessionId) ?? MAX_RANK_FALLBACK;
    const vecRank = vecRankMap.get(sessionId) ?? MAX_RANK_FALLBACK;
    const vecDistance = vecDistMap.get(sessionId) ?? Infinity;
    scored.push({ sessionId, ftsRank, vecRank, vecDistance });
  }
  scored.sort((a, b) => {
    const scoreA = ftsWeight / (rrfK + a.ftsRank + 1) + vecWeight / (rrfK + a.vecRank + 1);
    const scoreB = ftsWeight / (rrfK + b.ftsRank + 1) + vecWeight / (rrfK + b.vecRank + 1);
    if (Math.abs(scoreA - scoreB) > 0.000000001)
      return scoreB - scoreA;
    return a.vecDistance - b.vecDistance;
  });
  return scored;
}
function buildResults(db, fused, topK, sessionTitles) {
  const chunkCounts = countChunksPerSession(db);
  const titleMap = new Map(Object.entries(sessionTitles ?? {}));
  try {
    if (fused.length > 0) {
      const placeholders = fused.map(() => "?").join(",");
      const rows = db.prepare(`SELECT id, title FROM sessions WHERE id IN (${placeholders})`).all(...fused.map((f) => f.sessionId));
      for (const row of rows) {
        if (!titleMap.has(row.id)) {
          titleMap.set(row.id, row.title);
        }
      }
    }
  } catch {}
  const results = [];
  let rank = 0;
  for (const entry of fused) {
    rank++;
    if (rank > topK)
      break;
    const ftsOnly = entry.ftsRank < MAX_RANK_FALLBACK && entry.vecRank >= MAX_RANK_FALLBACK;
    const vecOnly = entry.vecRank < MAX_RANK_FALLBACK && entry.ftsRank >= MAX_RANK_FALLBACK;
    const matchType = ftsOnly ? "fts-only" : vecOnly ? "vector-only" : "hybrid";
    const rrfScore = 0.3 / (60 + entry.ftsRank + 1) + 0.7 / (60 + entry.vecRank + 1);
    results.push({
      sessionId: entry.sessionId,
      title: titleMap.get(entry.sessionId) ?? `Session ${entry.sessionId}`,
      score: Math.round(rrfScore * 1e6) / 1e6,
      rank,
      matchType,
      matchedChunks: chunkCounts.get(entry.sessionId) ?? 0
    });
  }
  return results;
}
function countChunksPerSession(db) {
  const counts = new Map;
  try {
    const rows = db.prepare(`SELECT session_id, COUNT(*) AS cnt FROM session_vec GROUP BY session_id`).all();
    for (const row of rows) {
      counts.set(row.session_id, row.cnt);
    }
  } catch {}
  return counts;
}

// ../../src/adapters/opencode.ts
var EXPECTED_SCHEMA = {
  tables: {
    project: ["id", "worktree"],
    session: ["id", "project_id", "directory", "title", "time_created", "time_updated"],
    message: ["id", "session_id", "time_created", "data"],
    part: ["id", "message_id", "session_id", "data"]
  }
};
var DEFAULT_LOCK_RETRIES = [50, 100, 200];
function createOpenCodeAdapter(entry, options = {}) {
  if (entry.agent !== "opencode") {
    throw new Error(`[opencode:${entry.alias}] OpenCode adapter requires agent "opencode", got "${entry.agent}"`);
  }
  const label = `[${entry.agent}:${entry.alias}]`;
  const cwd = options.cwd ?? process.cwd();
  const defaults = getOpenCodeDefaults();
  const storageInfo = resolveOpenCodeStorage(entry, defaults, { context: label });
  if (storageInfo.mode === "db") {
    return createDbAdapter(entry, storageInfo.path, cwd, label, options);
  } else {
    return createJsonlAdapter(entry, storageInfo.path, cwd, label);
  }
}
function getOpenCodeDefaults() {
  const home = homedir2();
  return {
    dbPath: join3(home, ".local", "share", "opencode", "opencode.db"),
    jsonlPath: join3(home, ".local", "share", "opencode", "opencode.jsonl")
  };
}
function createDbAdapter(entry, dbPath, cwd, label, options) {
  const db = openDatabaseWithRetry(dbPath, label, options.lockRetries ?? DEFAULT_LOCK_RETRIES);
  validateSchema(db, label);
  let similarityInitialized = false;
  const similarityCfg = {
    enabled: true,
    embeddingProvider: "local",
    topK: 5,
    vectorDimension: 384
  };
  return {
    version: "1.0.0",
    listSessions: () => listSessionsFromDb(db, entry, cwd, label),
    listSessionsByTimeRange: (options2) => listSessionsByTimeRangeFromDb(db, entry, cwd, options2, label),
    searchSessions: (query) => searchSessionsFromDb(db, entry, query, label),
    getSessionDetail: (sessionId, opts) => getSessionDetailFromDb(db, entry, sessionId, opts, label),
    forkSession: (sourceSessionId, destAgent, destAlias) => forkSessionDb(db, entry, cwd, sourceSessionId, destAgent, destAlias, label),
    toolSearchSessions: (query) => toolSearchFromDb(db, entry, cwd, query, label),
    findSimilarSessions: (sessionId, topK) => findSimilarSessionsDb(db, entry, cwd, label, sessionId, topK, similarityCfg, () => {
      if (!similarityInitialized) {
        initializeSimilarity(db, similarityCfg);
        similarityInitialized = true;
      }
    })
  };
}
function createJsonlAdapter(entry, jsonlPath, cwd, label) {
  try {
    const stat = statSync3(jsonlPath);
    if (!stat.isFile()) {
      throw new Error(`${label} JSONL path is not a file: ${jsonlPath}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes(label)) {
      throw error;
    }
    throw new Error(`${label} failed to access JSONL path: ${jsonlPath}`);
  }
  return {
    version: "1.0.0",
    listSessions: () => listSessionsFromJsonl(jsonlPath, entry, cwd, label),
    listSessionsByTimeRange: (options) => listSessionsByTimeRangeFromJsonl(jsonlPath, entry, cwd, options, label),
    searchSessions: (query) => searchSessionsFromJsonl(jsonlPath, entry, query, label),
    getSessionDetail: (sessionId, opts) => getSessionDetailFromJsonl(jsonlPath, entry, sessionId, opts, label),
    findSimilarSessions: async () => [],
    forkSession: (sourceSessionId, destAgent, destAlias) => forkSessionJsonl(jsonlPath, entry, sourceSessionId, destAgent, destAlias, label),
    toolSearchSessions: (query) => toolSearchFromJsonl(jsonlPath, entry, cwd, query, label)
  };
}
function openDatabaseWithRetry(path, label, retries) {
  let lastError = null;
  for (let attempt = 0;attempt < retries.length; attempt++) {
    try {
      const stat = statSync3(path);
      if (!stat.isFile()) {
        throw new Error(`${label} db_path is not a file: ${path}`);
      }
      return new Database(path, { readonly: true });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isLockError = lastError.message.toLowerCase().includes("locked") || lastError.message.toLowerCase().includes("busy") || lastError.message.includes("SQLITE_BUSY");
      if (attempt === retries.length - 1) {
        if (lastError.message.includes(label)) {
          throw lastError;
        }
        if (isLockError) {
          throw new Error(`${label} database locked after ${retries.length} attempts (delays: ${retries.join(",")}ms) - path: ${path}`);
        }
        throw new Error(`${label} failed to open database after ${retries.length} attempt(s): ${path} - ${lastError.message}`);
      }
      if (isLockError) {
        const start = Date.now();
        while (Date.now() - start < retries[attempt]) {}
      } else {
        if (lastError.message.includes(label)) {
          throw lastError;
        }
        throw new Error(`${label} failed to open database: ${path} - ${lastError.message}`);
      }
    }
  }
  throw new Error(`${label} unexpected state in openDatabaseWithRetry`);
}
function validateSchema(db, label) {
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const missingTables = [];
  const missingColumns = [];
  for (const [table, requiredColumns] of Object.entries(EXPECTED_SCHEMA.tables)) {
    if (!tables.includes(table)) {
      missingTables.push(table);
      continue;
    }
    const columns = db.query(`PRAGMA table_info(${table})`).all().map((r) => r.name);
    const missing = requiredColumns.filter((c) => !columns.includes(c));
    if (missing.length > 0) {
      missingColumns.push({ table, columns: missing });
    }
  }
  if (missingTables.length > 0 || missingColumns.length > 0) {
    const parts = [];
    if (missingTables.length > 0) {
      parts.push(`missing tables: ${missingTables.join(", ")}`);
    }
    if (missingColumns.length > 0) {
      const colParts = missingColumns.map((mc) => `${mc.table}(${mc.columns.join(", ")})`);
      parts.push(`missing columns: ${colParts.join("; ")}`);
    }
    throw new Error(`${label} schema mismatch: ${parts.join("; ")}. Expected schema: project(id, worktree), session(id, project_id, directory, title, time_created, time_updated), message(id, session_id, time_created, data), part(id, message_id, session_id, data)`);
  }
}
function listSessionsFromDb(db, entry, cwd, label) {
  const projectId = findProjectId(db, cwd, label);
  const normalizedCwd = resolve4(cwd);
  let rows;
  if (projectId) {
    rows = db.query(`SELECT s.id, s.project_id, s.parent_id, s.directory, s.title, s.time_created, s.time_updated,
                COUNT(m.id) AS message_count
         FROM session s
         LEFT JOIN message m ON m.session_id = s.id
         WHERE s.project_id = ?
         GROUP BY s.id
         ORDER BY s.time_updated DESC`).all(projectId);
  } else {
    rows = db.query(`SELECT s.id, s.project_id, s.parent_id, s.directory, s.title, s.time_created, s.time_updated,
                COUNT(m.id) AS message_count
         FROM session s
         LEFT JOIN message m ON m.session_id = s.id
         WHERE s.directory = ?
         GROUP BY s.id
         ORDER BY s.time_updated DESC`).all(normalizedCwd);
  }
  return rows.map((row) => ({
    id: row.id,
    agent: "opencode",
    alias: entry.alias,
    title: row.title || row.id,
    created_at: formatTimestamp(row.time_created),
    updated_at: formatTimestamp(row.time_updated),
    message_count: row.message_count,
    storage: "db",
    parentSessionId: row.parent_id ?? undefined
  }));
}
function listSessionsByTimeRangeFromDb(db, entry, cwd, options, label) {
  const projectId = findProjectId(db, cwd, label);
  const normalizedCwd = resolve4(cwd);
  const conditions = projectId ? ["s.project_id = ?"] : ["s.directory = ?"];
  const params = projectId ? [projectId] : [normalizedCwd];
  if (options.since !== undefined) {
    conditions.push("s.time_updated >= ?");
    params.push(options.since);
  }
  if (options.until !== undefined) {
    conditions.push("s.time_updated <= ?");
    params.push(options.until);
  }
  if (options.skipSessionId !== undefined) {
    conditions.push("s.id != ?");
    params.push(options.skipSessionId);
  }
  const limit = options.limit !== undefined ? options.limit : 50;
  const limitClause = limit > 0 ? ` LIMIT ${limit}` : "";
  const sql = `
    SELECT s.id, s.project_id, s.parent_id, s.directory, s.title, s.time_created, s.time_updated,
           COUNT(m.id) AS message_count
    FROM session s
    LEFT JOIN message m ON m.session_id = s.id
    WHERE ${conditions.join(" AND ")}
    GROUP BY s.id
    ORDER BY s.time_updated DESC
    ${limitClause}
  `;
  let rows;
  try {
    rows = db.query(sql).all(...params);
  } catch (error) {
    throw new Error(`${label} failed to query sessions by time range: ${errorMessage(error)}`);
  }
  return rows.map((row) => ({
    id: row.id,
    agent: "opencode",
    alias: entry.alias,
    title: row.title || row.id,
    created_at: formatTimestamp(row.time_created),
    updated_at: formatTimestamp(row.time_updated),
    message_count: row.message_count,
    storage: "db",
    parentSessionId: row.parent_id ?? undefined
  }));
}
function searchSessionsFromDb(db, entry, query, label) {
  const cwd = query.cwd ?? process.cwd();
  const projectId = findProjectId(db, cwd, label);
  const normalizedCwd = resolve4(cwd);
  const searchPattern = `%${query.text.toLowerCase()}%`;
  const idCondition = projectId ? "s.project_id = ?" : "s.directory = ?";
  const searchParams = projectId ? [projectId, searchPattern, searchPattern] : [normalizedCwd, searchPattern, searchPattern];
  const sql = `WITH matching_ids AS (
         SELECT DISTINCT s.id
         FROM session s
         LEFT JOIN part p ON p.session_id = s.id
         WHERE ${idCondition}
           AND (LOWER(s.title) LIKE ? OR LOWER(p.data) LIKE ?)
       )
       SELECT s.id, s.project_id, s.parent_id, s.directory, s.title, s.time_created, s.time_updated,
              COUNT(m.id) AS message_count
       FROM matching_ids ids
       JOIN session s ON s.id = ids.id
       LEFT JOIN message m ON m.session_id = s.id
       GROUP BY s.id
       ORDER BY s.time_updated DESC`;
  const rows = db.query(sql).all(...searchParams);
  return rows.map((row) => ({
    id: row.id,
    agent: "opencode",
    alias: entry.alias,
    title: row.title || row.id,
    created_at: formatTimestamp(row.time_created),
    updated_at: formatTimestamp(row.time_updated),
    message_count: row.message_count,
    storage: "db",
    parentSessionId: row.parent_id ?? undefined
  }));
}
async function getSessionDetailFromDb(db, entry, sessionId, options, label) {
  const session = db.query(`SELECT id, project_id, directory, title, time_created, time_updated
       FROM session
       WHERE id = ?`).get(sessionId);
  if (!session) {
    throw new Error(`${label} session not found: ${sessionId}`);
  }
  const messageCount = countMessages(db, sessionId, label);
  const baseSummary = {
    id: session.id,
    agent: "opencode",
    alias: entry.alias,
    title: session.title || session.id,
    created_at: formatTimestamp(session.time_created),
    updated_at: formatTimestamp(session.time_updated),
    message_count: messageCount,
    storage: "db"
  };
  const toolOptions = {};
  if (options.mode === "last_message") {
    toolOptions.lastOnly = true;
  } else if (options.mode === "all_with_tools") {
    toolOptions.includeAll = true;
  } else {
    toolOptions.excludeTools = true;
  }
  const selection = options.selection;
  if (selection) {
    const { messages: messages2, warning } = getMessagesWithSelection(db, sessionId, { ...selection, userOnly: selection.userOnly || options.userOnly }, toolOptions, label, options.role);
    return { ...baseSummary, messages: messages2, ...warning && { warning } };
  }
  if (options.userOnly) {
    const { messages: messages2, warning } = getMessagesWithSelection(db, sessionId, { mode: "last", count: 10, userOnly: true }, toolOptions, label, options.role);
    return { ...baseSummary, messages: messages2, ...warning && { warning } };
  }
  const messages = getMessagesFromDb(db, sessionId, toolOptions, label, options.role);
  return { ...baseSummary, messages };
}
function findProjectId(db, cwd, label) {
  try {
    const normalizedCwd = resolve4(cwd);
    const projects = db.query("SELECT id, worktree FROM project").all().map((p) => ({ id: p.id, worktree: resolve4(p.worktree) }));
    const exactMatch = projects.find((p) => p.worktree === normalizedCwd);
    if (exactMatch) {
      return exactMatch.id;
    }
    let currentDir = normalizedCwd;
    const root = resolve4("/");
    while (currentDir !== root) {
      currentDir = dirname3(currentDir);
      const parentMatch = projects.find((p) => p.worktree === currentDir);
      if (parentMatch) {
        return parentMatch.id;
      }
    }
    return null;
  } catch (error) {
    throw new Error(`${label} failed to query project: ${errorMessage(error)}`);
  }
}
function countMessages(db, sessionId, label) {
  try {
    const result = db.query(`SELECT COUNT(*) as count FROM message WHERE session_id = ?`).get(sessionId);
    return result?.count ?? 0;
  } catch (error) {
    throw new Error(`${label} failed to count messages: ${errorMessage(error)}`);
  }
}
function getMessagesFromDb(db, sessionId, options, label, roleFilter) {
  let query = `
    SELECT id, session_id, time_created, data
    FROM message
    WHERE session_id = ?
    ORDER BY time_created ASC
  `;
  if (options.lastOnly) {
    query = `
      SELECT id, session_id, time_created, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created DESC
      LIMIT 1
    `;
  }
  let messages;
  try {
    messages = db.query(query).all(sessionId);
  } catch (error) {
    throw new Error(`${label} failed to query messages: ${errorMessage(error)}`);
  }
  if (options.lastOnly && messages.length > 0) {
    messages.reverse();
  }
  const result = messages.map((row) => {
    let data;
    try {
      data = JSON.parse(row.data);
    } catch (error) {
      throw new Error(`${label} failed to parse message data for ${row.id}: ${errorMessage(error)}`);
    }
    const parts = getPartsFromDb(db, row.id, options, label);
    const modelID = data.model?.modelID || data.modelID;
    return {
      id: row.id,
      role: normalizeRole(data.role),
      created_at: formatTimestamp(row.time_created),
      parts,
      agent: data.agent,
      modelID
    };
  });
  if (roleFilter) {
    return result.filter((msg) => msg.role === roleFilter);
  }
  return result;
}
function getMessagesWithSelection(db, sessionId, selection, toolOptions, label, roleFilter) {
  let messages;
  try {
    messages = db.query(`SELECT id, session_id, time_created, data
         FROM message
         WHERE session_id = ?
         ORDER BY time_created ASC`).all(sessionId);
  } catch (error) {
    throw new Error(`${label} failed to query messages: ${errorMessage(error)}`);
  }
  const messagesWithRoles = messages.map((row) => {
    let data;
    try {
      data = JSON.parse(row.data);
    } catch (error) {
      throw new Error(`${label} failed to parse message data for ${row.id}: ${errorMessage(error)}`);
    }
    const modelID = data.model?.modelID || data.modelID;
    return { row, role: normalizeRole(data.role), agent: data.agent, modelID };
  });
  let selectedRows;
  let warning;
  switch (selection.mode) {
    case "first": {
      const count = selection.count ?? 10;
      selectedRows = messagesWithRoles.slice(0, count);
      break;
    }
    case "last": {
      const count = selection.count ?? 10;
      selectedRows = messagesWithRoles.slice(-count);
      break;
    }
    case "all": {
      selectedRows = messagesWithRoles;
      if (messagesWithRoles.length > 100) {
        warning = `Large message count (${messagesWithRoles.length}): consider using --first, --last, or --range for better performance`;
      }
      break;
    }
    case "range": {
      const start = selection.start ?? 1;
      const end = selection.end ?? messagesWithRoles.length;
      if (start < 1) {
        throw new Error(`${label} invalid range: start (${start}) must be >= 1`);
      }
      if (end < 1) {
        throw new Error(`${label} invalid range: end (${end}) must be >= 1`);
      }
      if (start > end) {
        throw new Error(`${label} invalid range: start (${start}) > end (${end})`);
      }
      const startIndex = start - 1;
      const endIndex = end;
      selectedRows = messagesWithRoles.slice(startIndex, endIndex);
      break;
    }
    case "user-only": {
      selectedRows = messagesWithRoles.filter((m) => m.role === "user");
      break;
    }
    default:
      throw new Error(`${label} unsupported selection mode: ${selection.mode}`);
  }
  if (selection.userOnly) {
    selectedRows = selectedRows.filter((m) => m.role === "user");
  }
  if (roleFilter) {
    selectedRows = selectedRows.filter((m) => m.role === roleFilter);
  }
  const selectedMessages = selectedRows.map(({ row }) => {
    const parts = getPartsFromDb(db, row.id, toolOptions, label);
    const msgData = messagesWithRoles.find((m) => m.row.id === row.id);
    return {
      id: row.id,
      role: msgData.role,
      created_at: formatTimestamp(row.time_created),
      parts,
      agent: msgData.agent,
      modelID: msgData.modelID
    };
  });
  return { messages: selectedMessages, warning };
}
function getPartsFromDb(db, messageId, options, label) {
  let parts;
  try {
    parts = db.query(`SELECT id, message_id, session_id, data
         FROM part
         WHERE message_id = ?
         ORDER BY time_created ASC`).all(messageId);
  } catch (error) {
    throw new Error(`${label} failed to query parts: ${errorMessage(error)}`);
  }
  return parts.map((row) => {
    let data;
    try {
      data = JSON.parse(row.data);
    } catch (error) {
      throw new Error(`${label} failed to parse part data for ${row.id}: ${errorMessage(error)}`);
    }
    const type = data.type ?? "unknown";
    if (type === "text") {
      return { type: "text", text: data.text ?? "" };
    }
    if (type === "tool") {
      return {
        type: "tool",
        tool: data.tool ?? "unknown",
        state: data.state ?? {}
      };
    }
    if (type === "reasoning") {
      return { type: "reasoning", text: data.text ?? "" };
    }
    return { type, ...data };
  }).filter((part) => {
    if (options.excludeTools && part.type === "tool") {
      return false;
    }
    if (options.excludeTools && part.type === "step-start") {
      return false;
    }
    if (options.excludeTools && part.type === "step-finish") {
      return false;
    }
    return true;
  });
}
function toolSearchFromDb(db, entry, cwd, query, label) {
  const projectId = findProjectId(db, cwd, label);
  const normalizedCwd = resolve4(cwd);
  const toolPattern = `%${query.tool}%`;
  const idCondition = projectId ? "s.project_id = ?" : "s.directory = ?";
  const searchParams = projectId ? [projectId, toolPattern] : [normalizedCwd, toolPattern];
  const sql = `WITH matching_sessions AS (
         SELECT DISTINCT s.id
         FROM session s
         JOIN message m ON m.session_id = s.id
         JOIN part p ON p.message_id = m.id
         WHERE ${idCondition}
           AND p.data LIKE ?
           AND p.data LIKE '%"type":"tool"%'
       )
       SELECT s.id, s.project_id, s.parent_id, s.directory, s.title, s.time_created, s.time_updated,
              COUNT(m.id) AS message_count
       FROM matching_sessions ids
       JOIN session s ON s.id = ids.id
       LEFT JOIN message m ON m.session_id = s.id
       GROUP BY s.id
       ORDER BY s.time_updated DESC
       LIMIT 100`;
  let rows;
  try {
    rows = db.query(sql).all(...searchParams);
  } catch {
    return [];
  }
  return rows.map((row) => ({
    id: row.id,
    agent: "opencode",
    alias: entry.alias,
    title: row.title || row.id,
    created_at: formatTimestamp(row.time_created),
    updated_at: formatTimestamp(row.time_updated),
    message_count: row.message_count,
    storage: "db",
    parentSessionId: row.parent_id ?? undefined
  }));
}
function toolSearchFromJsonl(jsonlPath, entry, cwd, query, _label) {
  const content = readTextFile(jsonlPath);
  if (!content)
    return [];
  if (!content.trim())
    return [];
  const toolNeedle = query.tool.toLowerCase();
  const results = [];
  for (const line of content.split(`
`)) {
    if (!line.trim())
      continue;
    try {
      const record = JSON.parse(line);
      if (record.projectID && !matchesProjectIdForJsonl(record.projectID, cwd)) {
        continue;
      }
      const hasTool = hasToolMentionInJsonl(record, toolNeedle);
      if (!hasTool)
        continue;
      const timeUpdated = record.timeUpdated ?? 0;
      const messageCount = record.messageCount ?? 0;
      results.push({
        id: record.id,
        agent: "opencode",
        alias: entry.alias,
        title: record.title || record.id,
        created_at: formatTimestamp(record.timeCreated),
        updated_at: formatTimestamp(timeUpdated),
        message_count: messageCount,
        storage: "other"
      });
    } catch {}
  }
  return sortByIsoDesc(results, "updated_at").slice(0, 100);
}
function hasToolMentionInJsonl(record, toolNeedle) {
  const json = JSON.stringify(record).toLowerCase();
  return json.includes(`"type":"tool"`) && json.includes(toolNeedle);
}
function matchesProjectIdForJsonl(projectID, cwd) {
  if (!projectID)
    return true;
  return cwd.includes(projectID) || projectID.includes(cwd);
}
function parseJsonlFile(jsonlPath, label) {
  const content = readTextFile(jsonlPath);
  if (!content) {
    return [];
  }
  if (!content.trim()) {
    return [];
  }
  const lines = content.split(`
`);
  const sessions = [];
  for (let i = 0;i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];
    if (!line || !line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      sessions.push(parsed);
    } catch (error) {
      throw new Error(`${label} malformed JSONL at line ${lineNum}: ${errorMessage(error)}`);
    }
  }
  return sessions;
}
function listSessionsFromJsonl(jsonlPath, entry, cwd, label) {
  const sessions = parseJsonlFile(jsonlPath, label);
  const normalizedCwd = resolve4(cwd);
  const filtered = sessions.filter((s) => {
    try {
      return s.directory && resolve4(s.directory) === normalizedCwd;
    } catch {
      return false;
    }
  });
  filtered.sort((a, b) => b.timeUpdated - a.timeUpdated);
  return filtered.map((row) => ({
    id: row.id,
    agent: "opencode",
    alias: entry.alias,
    title: row.title || row.id,
    created_at: formatTimestamp(row.timeCreated),
    updated_at: formatTimestamp(row.timeUpdated),
    message_count: 0,
    storage: "jsonl",
    parentSessionId: row.clone?.src?.session_id ?? undefined
  }));
}
function listSessionsByTimeRangeFromJsonl(jsonlPath, entry, cwd, options, label) {
  const sessions = parseJsonlFile(jsonlPath, label);
  const normalizedCwd = resolve4(cwd);
  const filtered = sessions.filter((s) => {
    try {
      if (!s.directory || resolve4(s.directory) !== normalizedCwd) {
        return false;
      }
    } catch {
      return false;
    }
    if (options.since !== undefined && s.timeUpdated < options.since) {
      return false;
    }
    if (options.until !== undefined && s.timeUpdated > options.until) {
      return false;
    }
    return true;
  });
  filtered.sort((a, b) => b.timeUpdated - a.timeUpdated);
  const limit = options.limit !== undefined ? options.limit : 50;
  const limited = limit > 0 ? filtered.slice(0, limit) : filtered;
  return limited.map((row) => ({
    id: row.id,
    agent: "opencode",
    alias: entry.alias,
    title: row.title || row.id,
    created_at: formatTimestamp(row.timeCreated),
    updated_at: formatTimestamp(row.timeUpdated),
    message_count: 0,
    storage: "jsonl"
  }));
}
function searchSessionsFromJsonl(jsonlPath, entry, query, label) {
  const sessions = parseJsonlFile(jsonlPath, label);
  const cwd = query.cwd ?? process.cwd();
  const normalizedCwd = resolve4(cwd);
  const searchLower = query.text.toLowerCase();
  const filtered = sessions.filter((s) => {
    try {
      if (!s.directory || resolve4(s.directory) !== normalizedCwd) {
        return false;
      }
    } catch {
      return false;
    }
    if (s.title && s.title.toLowerCase().includes(searchLower)) {
      return true;
    }
    return false;
  });
  filtered.sort((a, b) => b.timeUpdated - a.timeUpdated);
  return filtered.map((row) => ({
    id: row.id,
    agent: "opencode",
    alias: entry.alias,
    title: row.title || row.id,
    created_at: formatTimestamp(row.timeCreated),
    updated_at: formatTimestamp(row.timeUpdated),
    message_count: 0,
    storage: "jsonl"
  }));
}
async function getSessionDetailFromJsonl(jsonlPath, entry, sessionId, options, label) {
  const sessions = parseJsonlFile(jsonlPath, label);
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) {
    throw new Error(`${label} session not found in JSONL: ${sessionId}`);
  }
  const baseSummary = {
    id: session.id,
    agent: "opencode",
    alias: entry.alias,
    title: session.title || session.id,
    created_at: formatTimestamp(session.timeCreated),
    updated_at: formatTimestamp(session.timeUpdated),
    message_count: 0,
    storage: "jsonl"
  };
  let clone;
  if (session.clone) {
    clone = {
      src: session.clone.src ? {
        agent: session.clone.src.agent,
        session_id: session.clone.src.session_id,
        version: session.clone.src.version
      } : undefined,
      dst: session.clone.dst ? {
        agent: session.clone.dst.agent,
        session_id: session.clone.dst.session_id,
        version: session.clone.dst.version
      } : undefined
    };
  }
  return { ...baseSummary, messages: [], ...clone && { clone } };
}
function normalizeRole(role) {
  if (role === "user" || role === "assistant" || role === "system") {
    return role;
  }
  return "user";
}
function formatTimestamp(ms) {
  return new Date(ms).toISOString();
}
async function findSimilarSessionsDb(db, entry, cwd, label, sessionId, topK, similarityCfg, ensureInitialized) {
  try {
    ensureInitialized();
  } catch {}
  const detail = await getSessionDetailFromDb(db, entry, sessionId, { mode: "all_no_tools" }, label);
  try {
    indexSessionEmbeddings(db, detail);
  } catch {}
  const sessionText = collectSessionText(detail);
  const sessionTitles = {
    [sessionId]: detail.title
  };
  try {
    const results = await findSimilarSessions(db, sessionText, {
      topK: topK ?? 5,
      sessionTitles
    });
    return results.filter((r) => r.sessionId !== sessionId);
  } catch {
    return [];
  }
}
function collectSessionText(detail) {
  const parts = [];
  const messages = detail.messages ?? [];
  for (const msg of messages) {
    if (msg.role === "system")
      continue;
    const textParts = msg.parts?.filter((p) => p.type === "text") ?? [];
    for (const part of textParts) {
      const text = part.text;
      if (text && text.length >= 30) {
        parts.push(text);
      }
    }
  }
  return parts.join(" ");
}
async function forkSessionDb(db, entry, cwd, sourceSessionId, destAgent, destAlias, label) {
  const newSessionId = randomUUID2();
  const now = Math.floor(Date.now() / 1000);
  const forkedAt = new Date().toISOString();
  const sourceSession = db.query(`SELECT id, project_id, directory, title FROM session WHERE id = ?`).get(sourceSessionId);
  let projectId = null;
  try {
    const normalizedCwd = resolve4(cwd);
    projectId = db.query("SELECT id FROM project WHERE worktree = ?").get(normalizedCwd)?.id ?? null;
  } catch {
    if (sourceSession) {
      projectId = sourceSession.project_id;
    }
  }
  if (!projectId) {
    throw new Error(`${label} cannot fork: no OpenCode project found for cwd="${cwd}". ` + `Run 'oas onboard' to configure a project, or import via R-18.`);
  }
  const forkedTitle = sourceSession ? `Fork of ${sourceSession.title || sourceSession.id}` : `Fork of ${sourceSessionId}`;
  try {
    db.query(`INSERT INTO session (id, project_id, directory, title, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?)`).run(newSessionId, projectId, cwd, forkedTitle, now, now);
  } catch (error) {
    throw new Error(`${label} failed to create forked session row: ` + `${errorMessage(error)}`);
  }
  return {
    newSessionId,
    parentSessionId: sourceSessionId,
    destAgent,
    destAlias,
    forkedAt
  };
}
async function forkSessionJsonl(jsonlPath, entry, sourceSessionId, destAgent, destAlias, label) {
  const newSessionId = randomUUID2();
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const forkedAt = new Date().toISOString();
  let forkedTitle = `Fork of ${sourceSessionId}`;
  try {
    if (existsSync2(jsonlPath)) {
      const content = readFileSync3(jsonlPath, "utf8");
      for (const line of content.split(`
`)) {
        if (!line.trim())
          continue;
        try {
          const record = JSON.parse(line);
          if (record.id === sourceSessionId && record.title) {
            forkedTitle = `Fork of ${record.title}`;
            break;
          }
        } catch {}
      }
    }
  } catch {}
  const forkedRecord = {
    id: newSessionId,
    projectID: "",
    directory: process.cwd(),
    title: forkedTitle,
    timeCreated: nowSec,
    timeUpdated: nowSec,
    messageCount: 0,
    clone: {
      src: { agent: "opencode", session_id: sourceSessionId },
      dst: { agent: destAgent, session_id: newSessionId }
    }
  };
  try {
    appendFileSync(jsonlPath, JSON.stringify(forkedRecord) + `
`, "utf8");
  } catch (error) {
    throw new Error(`${label} failed to write forked session to JSONL: ` + `${errorMessage(error)}`);
  }
  return {
    newSessionId,
    parentSessionId: sourceSessionId,
    destAgent,
    destAlias,
    forkedAt
  };
}
function createOpenCodeCloneDestinationAdapter(entry, options = {}) {
  if (entry.agent !== "opencode") {
    throw new Error(`[opencode:${entry.alias}] OpenCode destination adapter requires agent "opencode", got "${entry.agent}"`);
  }
  const label = `[${entry.agent}:${entry.alias}]`;
  const cwd = options.cwd ?? process.cwd();
  const defaults = getOpenCodeDefaults();
  const storageInfo = resolveOpenCodeStorage(entry, defaults, { context: label });
  const jsonlPath = storageInfo.jsonlPath;
  return {
    agent: "opencode",
    alias: entry.alias,
    version: "1.0.0",
    generateSessionId: () => {
      return randomUUID2();
    },
    hasSession: (session_id) => {
      try {
        const sessions = parseJsonlFile(jsonlPath, label);
        return sessions.some((s) => s.id === session_id);
      } catch {
        return false;
      }
    },
    createSession: async (input) => {
      const { session, metadata } = input;
      const record = {
        id: session.id,
        projectID: "",
        directory: cwd,
        title: session.title,
        timeCreated: Date.parse(session.created_at),
        timeUpdated: Date.parse(session.updated_at),
        clone: metadata
      };
      const line = JSON.stringify(record) + `
`;
      try {
        appendFileSync(jsonlPath, line, "utf-8");
      } catch (error) {
        if (error instanceof Error && error.message.includes("ENOENT")) {
          try {
            writeFileSync(jsonlPath, line, "utf-8");
          } catch (writeError) {
            throw new Error(`${label} failed to create JSONL file: ${jsonlPath} - ${writeError instanceof Error ? writeError.message : String(writeError)}`);
          }
        } else {
          throw new Error(`${label} failed to append to JSONL file: ${jsonlPath} - ${errorMessage(error)}`);
        }
      }
    },
    isIdConflictError: (error) => {
      if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        return msg.includes("unique constraint") || msg.includes("primary key") || msg.includes("duplicate") || msg.includes("already exists");
      }
      return false;
    }
  };
}
// ../../src/adapters/codex.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join4 } from "node:path";
import { Database as Database2 } from "bun:sqlite";

// ../../src/adapters/label.ts
function createLabel(entry) {
  return `[${entry.agent}:${entry.alias}]`;
}

// ../../src/adapters/content-utils.ts
function textOfRecord(record) {
  return (typeof record.text === "string" ? record.text : null) ?? (typeof record.output_text === "string" ? record.output_text : null) ?? (typeof record.input_text === "string" ? record.input_text : null) ?? "";
}
function textOfRecordCodex(record) {
  return (typeof record.input_text === "string" ? record.input_text : null) ?? (typeof record.text === "string" ? record.text : null) ?? (typeof record.output_text === "string" ? record.output_text : null) ?? "";
}
function firstLine(text) {
  const line = text.split(/\r?\n/)[0]?.trim();
  return line && line.length > 0 ? line : undefined;
}
function extractContentTextCodex(content) {
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    const pieces = content.map((item) => {
      if (typeof item === "string")
        return item;
      if (item && typeof item === "object")
        return textOfRecordCodex(item);
      return "";
    }).filter((p) => p.length > 0);
    return pieces.length > 0 ? pieces.join("") : undefined;
  }
  if (content && typeof content === "object")
    return textOfRecord(content);
  return;
}
function extractContentTextClaude(content) {
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    const pieces = content.map((item) => {
      if (typeof item === "string")
        return item;
      if (item && typeof item === "object")
        return textOfRecord(item);
      return "";
    }).filter((p) => p.length > 0);
    return pieces.length > 0 ? pieces.join("") : undefined;
  }
  if (content && typeof content === "object")
    return textOfRecord(content);
  return;
}
function extractContentLine(content) {
  const text = extractContentTextClaude(content);
  return text ? firstLine(text) : undefined;
}
function extractContentLineGemini(content) {
  const text = extractContentTextGemini(content);
  return text ? firstLine(text) : undefined;
}
function extractFirstResponseLine(content) {
  const text = extractContentTextCodex(content);
  return text ? firstLine(text) : undefined;
}
function extractContentPartsCodex(content) {
  const parts = [];
  if (typeof content === "string") {
    parts.push(content);
    return parts;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "string")
        parts.push(item);
      else if (item && typeof item === "object") {
        const t = textOfRecordCodex(item);
        if (t)
          parts.push(t);
      }
    }
  } else if (content && typeof content === "object") {
    const t = textOfRecordCodex(content);
    if (t)
      parts.push(t);
  }
  return parts;
}
function extractContentPartsClaude(content) {
  const parts = [];
  if (typeof content === "string") {
    parts.push(content);
    return parts;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "string")
        parts.push(item);
      else if (item && typeof item === "object") {
        const t = textOfRecord(item);
        if (t)
          parts.push(t);
      }
    }
  } else if (content && typeof content === "object") {
    const t = textOfRecord(content);
    if (t)
      parts.push(t);
  }
  return parts;
}
function extractContentTextGemini(content) {
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    const pieces = content.filter((item) => item != null).map((item) => item.text ?? "").filter((t) => t.length > 0);
    return pieces.length > 0 ? pieces.join("") : undefined;
  }
  return;
}
function extractContentPartsGemini(content) {
  if (typeof content === "string")
    return [content];
  if (Array.isArray(content)) {
    return content.filter((item) => item != null).map((item) => item.text ?? "").filter((t) => t.length > 0);
  }
  return [];
}

// ../../src/adapters/codex.ts
function createCodexAdapter(entry, options = {}) {
  if (entry.agent !== "codex") {
    throw new Error(`Codex adapter requires agent "codex", got "${entry.agent}"`);
  }
  return {
    version: "1.0.0",
    listSessions: () => {
      const label = createLabel(entry);
      try {
        const rootPath = resolveCodexPath(entry, options);
        if (rootPath.endsWith(".sqlite")) {
          const results = listSessionsByTimeRangeFromSqlite(rootPath, entry, { since: 0, limit: 0 }, label);
          return results;
        }
        const files = collectJsonlFiles(rootPath);
        const sessions = [];
        for (const filePath of files) {
          const session = parseCodexSession(filePath, entry);
          if (session.id) {
            sessions.push(session);
          }
        }
        return sessions;
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    listSessionsByTimeRange: (rangeOpts) => {
      const label = createLabel(entry);
      const since = rangeOpts.since ?? 0;
      const limit = rangeOpts.limit ?? 50;
      const skipId = rangeOpts.skipSessionId;
      try {
        const rootPath = resolveCodexPath(entry, options);
        if (rootPath.endsWith(".sqlite")) {
          return listSessionsByTimeRangeFromSqlite(rootPath, entry, { since, limit, skipSessionId: skipId }, label);
        }
        const files = collectJsonlFiles(rootPath);
        const summaries = [];
        for (const filePath of files) {
          try {
            const summary = parseCodexSessionForTimeRange(filePath, entry);
            if (!summary.id)
              continue;
            if (skipId !== undefined && summary.id === skipId)
              continue;
            const updatedAtMs = Date.parse(summary.updated_at);
            if (updatedAtMs < since)
              continue;
            summaries.push(summary);
          } catch {}
        }
        summaries.sort((a, b) => {
          const timeDelta = Date.parse(b.updated_at) - Date.parse(a.updated_at);
          if (timeDelta !== 0)
            return timeDelta;
          return a.id.localeCompare(b.id);
        });
        return summaries.slice(0, limit);
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    searchSessions: (query) => {
      const label = createLabel(entry);
      try {
        const rootPath = resolveCodexPath(entry, options);
        const files = collectJsonlFiles(rootPath);
        const needle = query.text.toLowerCase();
        const results = [];
        for (const filePath of files) {
          try {
            const session = parseCodexSession(filePath, entry);
            const titleMatch = session.title.toLowerCase().includes(needle);
            const contentMatch = contentContains(filePath, needle);
            if (titleMatch || contentMatch) {
              results.push(session);
            }
          } catch {}
        }
        results.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
        return results;
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    getSessionDetail: async (sessionId, _options) => {
      const label = createLabel(entry);
      const rootPath = resolveCodexPath(entry, options);
      if (rootPath.endsWith(".sqlite")) {
        return getSessionDetailFromSqlite(rootPath, sessionId, entry, _options, label);
      }
      const files = collectJsonlFiles(rootPath);
      for (const filePath of files) {
        try {
          const summary = parseCodexSession(filePath, entry);
          if (summary.id === sessionId) {
            const messages = parseCodexMessages(filePath, sessionId, label);
            return {
              ...summary,
              messages
            };
          }
        } catch {}
      }
      throw new Error(`${label} session not found: ${sessionId}`);
    },
    findSimilarSessions: async () => [
      {
        sessionId: "",
        title: "",
        score: 0,
        rank: 0,
        matchType: "none",
        matchedChunks: 0,
        note: "Not yet supported"
      }
    ]
  };
}
function resolveCodexPath(entry, options) {
  const rawPath = entry.path;
  if (rawPath !== undefined && typeof rawPath !== "string") {
    throw new Error(`Codex path must be a non-empty string`);
  }
  if (typeof rawPath === "string" && rawPath.trim().length === 0) {
    throw new Error(`Codex path must be a non-empty string`);
  }
  const configured = typeof rawPath === "string" ? rawPath : undefined;
  const fallback = options.defaultPath ?? join4(homedir3(), ".codex", "sessions");
  const resolved = resolvePath(configured ?? fallback, options.configDir);
  const stat = safeStat(resolved);
  if (!stat) {
    throw new Error(`Codex path not found: ${resolved}`);
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`Codex path is not a file or directory: ${resolved}`);
  }
  return resolved;
}
function parseCodexSession(filePath, entry) {
  try {
    return parseCodexSessionInner(filePath, entry);
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes("JSONL parse error")) {
      return { ...EMPTY_CODEX_SESSION };
    }
    throw error;
  }
}
function parseCodexSessionForTimeRange(filePath, entry) {
  try {
    return parseCodexSessionForTimeRangeInner(filePath, entry);
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes("JSONL parse error")) {
      return { ...EMPTY_CODEX_SESSION };
    }
    throw error;
  }
}
function parseCodexSessionForTimeRangeInner(filePath, entry) {
  const lines = splitJsonlLines(readFileSync4(filePath, "utf8"));
  const sessions = [];
  let currentId;
  let currentCreatedAt;
  let currentMaxTs;
  let currentParentId;
  for (const raw of lines) {
    if (raw.trim().length === 0)
      continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      throw new Error(`Codex JSONL parse error in ${filePath}`);
    }
    if (record.type === "session_meta") {
      if (currentId !== undefined && currentCreatedAt !== undefined && currentMaxTs !== undefined) {
        sessions.push({ id: currentId, timestamp: currentCreatedAt, maxTimestamp: currentMaxTs, parentId: currentParentId });
      }
      currentId = readString(record.payload?.id, `Codex session id missing in ${filePath}`);
      currentCreatedAt = normalizeTimestamp(record.payload?.timestamp, `Codex created_at invalid for ${currentId} in ${filePath}`);
      currentMaxTs = currentCreatedAt;
      currentParentId = readOptionalString(record.payload?.parent_id);
      continue;
    }
    if (currentId === undefined)
      continue;
    if (record.timestamp !== undefined && record.timestamp !== null) {
      const ctx = `Codex timestamp invalid for ${currentId} in ${filePath}`;
      const ts = normalizeTimestamp(record.timestamp, ctx);
      currentMaxTs = currentMaxTs ? maxIso(currentMaxTs, ts) : ts;
    }
  }
  if (currentId !== undefined && currentCreatedAt !== undefined && currentMaxTs !== undefined) {
    sessions.push({ id: currentId, timestamp: currentCreatedAt, maxTimestamp: currentMaxTs, parentId: currentParentId });
  }
  if (sessions.length === 0) {
    throw new Error(`Codex session missing session_meta: ${filePath}`);
  }
  if (sessions.length === 1) {
    const s = sessions[0];
    return {
      id: s.id,
      agent: "codex",
      alias: entry.alias,
      title: s.id,
      created_at: s.timestamp,
      updated_at: s.maxTimestamp,
      message_count: 0,
      storage: "other",
      parentSessionId: s.parentId
    };
  }
  let best = sessions[0];
  for (let i = 1;i < sessions.length; i++) {
    if (Date.parse(sessions[i].maxTimestamp) > Date.parse(best.maxTimestamp)) {
      best = sessions[i];
    }
  }
  return {
    id: best.id,
    agent: "codex",
    alias: entry.alias,
    title: best.id,
    created_at: best.timestamp,
    updated_at: best.maxTimestamp,
    message_count: 0,
    storage: "other",
    parentSessionId: best.parentId
  };
}
function parseCodexSessionInner(filePath, entry) {
  const lines = splitJsonlLines(readFileSync4(filePath, "utf8"));
  let sessionMeta;
  let title;
  let messageCount = 0;
  let maxTimestamp;
  let sessionId;
  const entries = [];
  for (let i = 0;i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw.length === 0) {
      continue;
    }
    const record = parseJsonLine(raw, filePath, i + 1);
    if (record.type === "session_meta") {
      sessionId = readOptionalString(record.payload?.id) ?? sessionId;
    }
    entries.push({ record, lineNumber: i + 1 });
  }
  for (const entryInfo of entries) {
    const record = entryInfo.record;
    if (record.timestamp !== undefined && record.timestamp !== null) {
      const timestampContext = sessionId ? `Codex timestamp invalid for ${sessionId} at ${filePath}:${entryInfo.lineNumber}` : `Codex timestamp invalid at ${filePath}:${entryInfo.lineNumber}`;
      const timestampIso = normalizeTimestamp(record.timestamp, timestampContext);
      maxTimestamp = maxTimestamp ? maxIso(maxTimestamp, timestampIso) : timestampIso;
    }
    if (record.type === "session_meta") {
      sessionMeta = record;
      continue;
    }
    if (record.type === "response_item") {
      const payload = record.payload ?? {};
      const role = payload.role;
      if (role === "user" || role === "assistant") {
        messageCount += 1;
      }
      if (!title && role === "user") {
        const extracted = extractFirstResponseLine(payload.content);
        if (extracted) {
          title = extracted;
        }
      }
    }
  }
  if (!sessionMeta) {
    throw new Error(`Codex session missing session_meta: ${filePath}`);
  }
  const resolvedSessionId = readString(sessionMeta.payload?.id, `Codex session id missing in ${filePath}`);
  const createdAt = normalizeTimestamp(sessionMeta.payload?.timestamp, `Codex created_at invalid for ${resolvedSessionId} in ${filePath}`);
  if (!maxTimestamp) {
    throw new Error(`Codex updated_at missing for ${resolvedSessionId} in ${filePath}`);
  }
  const metaTitle = readOptionalString(sessionMeta.payload?.title);
  const resolvedTitle = preferTitle(metaTitle, title, resolvedSessionId);
  const parentId = readOptionalString(sessionMeta.payload?.parent_id);
  return {
    id: resolvedSessionId,
    agent: "codex",
    alias: entry.alias,
    title: resolvedTitle,
    created_at: createdAt,
    updated_at: maxTimestamp,
    message_count: messageCount,
    storage: "other",
    parentSessionId: parentId
  };
}
function parseJsonLine(line, filePath, lineNumber) {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Codex JSONL parse error in ${filePath} at line ${lineNumber}`);
  }
}
function extractContentText(content) {
  return extractContentTextCodex(content);
}
function readString(value, context) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new Error(context);
}
function readOptionalString(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return;
}
var EMPTY_CODEX_SESSION = Object.freeze({
  id: "",
  agent: "codex",
  alias: "",
  title: "",
  created_at: "",
  updated_at: "",
  message_count: 0,
  storage: "other"
});
function preferTitle(metaTitle, fallbackTitle, sessionId) {
  if (metaTitle && metaTitle.length > 0)
    return metaTitle;
  if (fallbackTitle && fallbackTitle.length > 0)
    return fallbackTitle;
  return sessionId;
}
function parseCodexMessages(filePath, _sessionId, label) {
  const lines = splitJsonlLines(readFileSync4(filePath, "utf8"));
  const messages = [];
  for (let i = 0;i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw.length === 0)
      continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      throw new Error(`Codex JSONL parse error in ${filePath} at line ${i + 1}`);
    }
    if (record.type !== "response_item")
      continue;
    const payload = record.payload ?? {};
    const role = payload.role;
    if (role !== "user" && role !== "assistant")
      continue;
    const timestampContext = `${label} timestamp invalid in ${filePath}:${i + 1}`;
    const created_at = normalizeTimestamp(record.timestamp, timestampContext);
    const content = payload.content;
    const textParts = extractContentPartsCodex(content);
    const parts = textParts.map((text) => ({
      type: "text",
      text
    }));
    const modelID = typeof payload.modelID === "string" ? payload.modelID : undefined;
    messages.push({
      id: `${filePath}:${i + 1}`,
      role,
      created_at,
      parts,
      modelID
    });
  }
  return messages;
}
function listSessionsByTimeRangeFromSqlite(dbPath, entry, options, label) {
  let db;
  try {
    db = new Database2(dbPath, { readonly: true });
  } catch (error) {
    throw new Error(`${label} failed to open SQLite DB ${dbPath}: ${errorMessage(error)}`);
  }
  try {
    const conditions = ["updated_at >= ?"];
    const params = [options.since / 1000];
    if (options.skipSessionId !== undefined) {
      conditions.push("id != ?");
      params.push(options.skipSessionId);
    }
    const limitClause = options.limit > 0 ? ` LIMIT ${options.limit}` : "";
    const sql = `
      SELECT id, title, created_at, updated_at, model, cwd
      FROM threads
      WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC, id DESC
      ${limitClause}
    `;
    let rows;
    try {
      rows = db.query(sql).all(...params);
    } catch (error) {
      throw new Error(`${label} SQLite query failed: ${errorMessage(error)}`);
    }
    return rows.map((row) => ({
      id: row.id,
      agent: "codex",
      alias: entry.alias,
      title: row.title || row.id,
      created_at: formatUnixSeconds(row.created_at),
      updated_at: formatUnixSeconds(row.updated_at),
      message_count: 0,
      storage: "other"
    }));
  } finally {
    db.close();
  }
}
async function getSessionDetailFromSqlite(dbPath, sessionId, entry, _options, label) {
  let db;
  try {
    db = new Database2(dbPath, { readonly: true });
  } catch (error) {
    throw new Error(`${label} failed to open SQLite DB ${dbPath}: ${errorMessage(error)}`);
  }
  try {
    const sql = `SELECT id, title, created_at, updated_at, rollout_path
                FROM threads WHERE id = ?`;
    const rows = db.query(sql).all(sessionId);
    if (rows.length === 0) {
      throw new Error(`${label} session not found: ${sessionId}`);
    }
    const row = rows[0];
    const summary = {
      id: row.id,
      agent: "codex",
      alias: entry.alias,
      title: row.title || row.id,
      created_at: formatUnixSeconds(row.created_at),
      updated_at: formatUnixSeconds(row.updated_at),
      message_count: 0,
      storage: "other"
    };
    const rolloutPath = row.rollout_path?.trim();
    if (rolloutPath && rolloutPath.length > 0) {
      try {
        const messages = parseCodexMessages(rolloutPath, sessionId, label);
        return { ...summary, messages, message_count: messages.length };
      } catch {}
    }
    const fallback = await getSessionDetailFromJsonlFallback(sessionId, entry, label);
    return { ...summary, message_count: fallback.messages.length, messages: fallback.messages };
  } finally {
    db.close();
  }
}
async function getSessionDetailFromJsonlFallback(sessionId, entry, label) {
  const fallbackRoot = join4(homedir3(), ".codex", "sessions");
  const files = collectJsonlFiles(fallbackRoot);
  for (const filePath of files) {
    try {
      const summary = parseCodexSession(filePath, entry);
      if (summary.id === sessionId) {
        const messages = parseCodexMessages(filePath, sessionId, label);
        return { messages };
      }
    } catch {}
  }
  return { messages: [] };
}
function formatUnixSeconds(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString();
}
function createCodexCloneSourceAdapter(entry, options = {}) {
  if (entry.agent !== "codex") {
    throw new Error(`Codex source adapter requires agent "codex", got "${entry.agent}"`);
  }
  const label = createLabel(entry);
  return {
    agent: "codex",
    alias: entry.alias,
    version: "1.0.0",
    getSession: async (session_id) => {
      try {
        const rootPath = resolveCodexPath(entry, options);
        const files = collectJsonlFiles(rootPath);
        for (const filePath of files) {
          const session = parseCodexSessionForClone(filePath, session_id, label);
          if (session) {
            return session;
          }
        }
        return null;
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    }
  };
}
function parseCodexSessionForClone(filePath, targetSessionId, label) {
  const lines = splitJsonlLines(readFileSync4(filePath, "utf8"));
  let sessionId;
  let sessionMeta;
  let title;
  let createdAt;
  let maxTimestamp;
  const messages = [];
  const entries = [];
  for (let i = 0;i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw.length === 0) {
      continue;
    }
    const record = parseJsonLine(raw, filePath, i + 1);
    if (record.type === "session_meta") {
      sessionId = readOptionalString(record.payload?.id) ?? sessionId;
    }
    entries.push({ record, lineNumber: i + 1 });
  }
  if (!sessionId || sessionId !== targetSessionId) {
    return null;
  }
  for (const entryInfo of entries) {
    const record = entryInfo.record;
    if (record.timestamp !== undefined && record.timestamp !== null) {
      const timestampContext = `Codex timestamp invalid for ${sessionId} at ${filePath}:${entryInfo.lineNumber}`;
      const timestampIso = normalizeTimestamp(record.timestamp, timestampContext);
      maxTimestamp = maxTimestamp ? maxIso(maxTimestamp, timestampIso) : timestampIso;
    }
    if (record.type === "session_meta") {
      sessionMeta = record;
      continue;
    }
    if (record.type === "response_item") {
      const payload = record.payload ?? {};
      const role = payload.role;
      if (role === "user" || role === "assistant") {
        const content = extractContentText(payload.content) ?? "";
        const timestamp = normalizeTimestamp(record.timestamp, `Codex message timestamp invalid for ${sessionId} at ${filePath}:${entryInfo.lineNumber}`);
        messages.push({
          role,
          content,
          created_at: timestamp
        });
        if (!title && role === "user") {
          const extracted = extractFirstResponseLine(payload.content);
          if (extracted) {
            title = extracted;
          }
        }
      }
    }
  }
  if (!sessionMeta) {
    throw new Error(`${label} Codex session missing session_meta: ${filePath}`);
  }
  const metaTitle = readOptionalString(sessionMeta.payload?.title);
  const resolvedTitle = preferTitle(metaTitle, title, sessionId);
  createdAt = normalizeTimestamp(sessionMeta.payload?.timestamp, `Codex created_at invalid for ${sessionId} in ${filePath}`);
  if (!maxTimestamp) {
    throw new Error(`${label} Codex updated_at missing for ${sessionId} in ${filePath}`);
  }
  return {
    id: sessionId,
    title: resolvedTitle,
    created_at: createdAt,
    updated_at: maxTimestamp,
    messages
  };
}
// ../../src/adapters/claude.ts
import { readFileSync as readFileSync5 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { basename, join as join5 } from "node:path";
var __dirname = "/home/bhd/Documents/Projects/bhd/oas-command-stats/src/adapters";
var PKG_VERSION = JSON.parse(readFileSync5(join5(__dirname, "../../package.json"), "utf8")).version;
function createClaudeAdapter(entry, options = {}) {
  if (entry.agent !== "claude") {
    throw new Error(`Claude adapter requires agent "claude", got "${entry.agent}"`);
  }
  return {
    version: PKG_VERSION,
    listSessions: () => {
      const label = createLabel(entry);
      try {
        const rootPath = resolveClaudePath(entry, options);
        const files = collectJsonlFiles(rootPath);
        return files.map((filePath) => parseClaudeSession(filePath, entry));
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    searchSessions: (query) => {
      const label = createLabel(entry);
      try {
        const rootPath = resolveClaudePath(entry, options);
        const files = collectJsonlFiles(rootPath);
        const needle = query.text.toLowerCase();
        const results = [];
        for (const filePath of files) {
          try {
            const session = parseClaudeSession(filePath, entry);
            const titleMatch = session.title.toLowerCase().includes(needle);
            const contentMatch = contentContains(filePath, needle);
            if (titleMatch || contentMatch) {
              results.push(session);
            }
          } catch {}
        }
        return sortByIsoDesc(results, "updated_at");
        return results;
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    getSessionDetail: async (sessionId, opts) => {
      const label = createLabel(entry);
      const rootPath = resolveClaudePath(entry, options);
      const files = collectJsonlFiles(rootPath);
      for (const filePath of files) {
        const sessionIdFromFile = basename(filePath, ".jsonl");
        if (sessionIdFromFile === sessionId) {
          let messages = parseClaudeMessages(filePath, label);
          const summary = parseClaudeSession(filePath, entry);
          if (opts.mode === "last_message") {
            messages = messages.slice(-1);
          } else if (opts.mode === "all_no_tools") {
            messages = messages.map((m) => ({
              ...m,
              parts: m.parts.filter((p) => p.type !== "tool")
            }));
          } else {
            const selection = opts.selection;
            if (selection) {
              switch (selection.mode) {
                case "first":
                  messages = messages.slice(0, selection.count);
                  break;
                case "last":
                  messages = selection.count === 0 ? messages : messages.slice(-(selection.count ?? 10));
                  break;
                case "range": {
                  const start = (selection.start ?? 1) - 1;
                  const end = selection.end ?? messages.length;
                  messages = messages.slice(start, end);
                  break;
                }
                case "all":
                default:
                  break;
              }
            }
            const effectiveUserOnly = opts.userOnly || opts.selection?.userOnly;
            if (effectiveUserOnly) {
              if (opts.role && opts.role !== "user") {
                messages = [];
              } else {
                messages = messages.filter((m) => m.role === "user");
              }
            } else if (opts.role) {
              messages = messages.filter((m) => m.role === opts.role);
            }
          }
          return {
            ...summary,
            messages
          };
        }
      }
      throw new Error(`${label} session not found: ${sessionId}`);
    },
    listSessionsByTimeRange: (opts) => {
      const label = createLabel(entry);
      try {
        const sinceMs = opts.since != null ? opts.since : 0;
        const untilMs = opts.until != null ? opts.until : 8640000000000000;
        const skipId = opts.skipSessionId;
        const rootPath = resolveClaudePath(entry, options);
        const files = collectJsonlFiles(rootPath);
        let results = [];
        for (const filePath of files) {
          try {
            const session = parseClaudeSession(filePath, entry);
            if (skipId === session.id)
              continue;
            const updatedMs = Date.parse(session.updated_at);
            if (Number.isNaN(updatedMs))
              continue;
            if (updatedMs < sinceMs || updatedMs > untilMs)
              continue;
            results.push(session);
          } catch {}
        }
        results = sortByIsoDesc(results, "updated_at");
        if (opts.limit && opts.limit > 0) {
          results = results.slice(0, opts.limit);
        }
        return results;
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    toolSearchSessions: (query) => {
      const label = createLabel(entry);
      try {
        const needle = query.tool.toLowerCase();
        const rootPath = resolveClaudePath(entry, options);
        const files = collectJsonlFiles(rootPath);
        const results = [];
        for (const filePath of files) {
          try {
            if (sessionUsesTool(filePath, needle)) {
              results.push(parseClaudeSession(filePath, entry));
            }
          } catch {}
        }
        return sortByIsoDesc(results, "updated_at");
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    forkSession: async (sourceSessionId, destAgent, destAlias) => {
      return {
        newSessionId: `claude-fork-${Date.now()}`,
        parentSessionId: sourceSessionId,
        destAgent,
        destAlias,
        forkedAt: new Date().toISOString()
      };
    },
    destroy: () => {},
    findSimilarSessions: async () => [
      {
        sessionId: "",
        title: "",
        score: 0,
        rank: 0,
        matchType: "none",
        matchedChunks: 0,
        note: "Not yet supported"
      }
    ]
  };
}
function resolveClaudePath(entry, options) {
  const rawPath = entry.path;
  if (rawPath !== undefined && typeof rawPath !== "string") {
    throw new Error(`Claude path must be a non-empty string`);
  }
  if (typeof rawPath === "string" && rawPath.trim().length === 0) {
    throw new Error(`Claude path must be a non-empty string`);
  }
  const configured = typeof rawPath === "string" ? rawPath : undefined;
  const home = options.homeDir ?? homedir4();
  const defaultPath = options.defaultPath ?? (safeStat(join5(home, ".claude", "transcripts")) ? join5(home, ".claude", "transcripts") : join5(home, ".claude", "sessions"));
  const resolved = resolvePath(configured ?? defaultPath, options.configDir);
  const stat = safeStat(resolved);
  if (!stat) {
    throw new Error(`Claude path not found: ${resolved}`);
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`Claude path is not a file or directory: ${resolved}`);
  }
  return resolved;
}
function parseClaudeSession(filePath, entry) {
  const sessionId = basename(filePath, ".jsonl");
  if (!sessionId || sessionId.trim().length === 0 || sessionId.startsWith(".")) {
    throw new Error(`Claude session id missing for ${filePath}`);
  }
  const lines = splitJsonlLines(readFileSync5(filePath, "utf8"));
  let title;
  let messageCount = 0;
  let minTimestamp;
  let maxTimestamp;
  let parentSessionId;
  for (let i = 0;i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw.length === 0) {
      continue;
    }
    const record = parseJsonLine2(raw, filePath, i + 1);
    const recordType = record.type;
    if (!parentSessionId) {
      parentSessionId = readOptionalString2(record.parent_session_id);
    }
    if (record.timestamp !== undefined && record.timestamp !== null) {
      const recordId = record.id;
      const context = typeof recordId === "string" && recordId.length > 0 ? `Claude timestamp invalid for ${sessionId} record ${recordId} at ${filePath}:${i + 1}` : `Claude timestamp invalid for ${sessionId} (missing record id) at ${filePath}:${i + 1}`;
      const timestampIso = normalizeTimestamp(record.timestamp, context);
      minTimestamp = minTimestamp ? minIso(minTimestamp, timestampIso) : timestampIso;
      maxTimestamp = maxTimestamp ? maxIso(maxTimestamp, timestampIso) : timestampIso;
    }
    if (recordType === "user" || recordType === "assistant") {
      messageCount += 1;
    }
    if (!title && recordType === "user") {
      const extracted = extractContentLine(record.content);
      if (extracted) {
        title = extracted;
      }
    }
  }
  if (!minTimestamp || !maxTimestamp) {
    throw new Error(`Claude timestamps missing for ${sessionId} in ${filePath}`);
  }
  return {
    id: sessionId,
    agent: "claude",
    alias: entry.alias,
    title: title && title.length > 0 ? title : sessionId,
    created_at: minTimestamp,
    updated_at: maxTimestamp,
    message_count: messageCount,
    storage: "other",
    parentSessionId
  };
}
function parseJsonLine2(line, filePath, lineNumber) {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Claude JSONL parse error in ${filePath} at line ${lineNumber}`);
  }
}
function readOptionalString2(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return;
}
function parseClaudeMessages(filePath, label) {
  const lines = splitJsonlLines(readFileSync5(filePath, "utf8"));
  const messages = [];
  for (let i = 0;i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw.length === 0)
      continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      throw new Error(`Claude JSONL parse error in ${filePath} at line ${i + 1}`);
    }
    const recordType = record.type;
    if (recordType !== "user" && recordType !== "assistant")
      continue;
    const recordId = record.id;
    const context = typeof recordId === "string" ? `${label} timestamp invalid in ${filePath}:${i + 1}` : `${label} timestamp invalid (missing record id) in ${filePath}:${i + 1}`;
    const created_at = normalizeTimestamp(record.timestamp, context);
    const parts = mapClaudeContent(record.content);
    const message = {
      id: typeof recordId === "string" ? recordId : `${filePath}:${i + 1}`,
      role: recordType,
      created_at,
      parts
    };
    const modelID = readOptionalString2(record.model);
    const agentField = readOptionalString2(record.agent);
    if (modelID)
      message.modelID = modelID;
    if (agentField)
      message.agent = agentField;
    messages.push(message);
  }
  return messages;
}
function mapClaudeContent(content) {
  const parts = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      parts.push(mapClaudeContentBlock(block));
    }
  } else if (typeof content === "string") {
    parts.push({ type: "text", text: content });
  } else if (content !== null && content !== undefined) {
    const textParts = extractContentPartsClaude(content);
    for (const text of textParts) {
      parts.push({ type: "text", text });
    }
  }
  return parts;
}
function mapClaudeContentBlock(block) {
  if (block === null || typeof block !== "object") {
    return { type: "text", text: "" };
  }
  const b = block;
  const t = typeof b.type === "string" ? b.type : "";
  if (t === "text") {
    const text = typeof b.text === "string" ? b.text : "";
    return { type: "text", text };
  }
  if (t === "tool_use") {
    const name = typeof b.name === "string" ? b.name : "";
    const input = b.input;
    return {
      type: "tool",
      tool: name,
      state: { input: input && typeof input === "object" ? input : {} }
    };
  }
  if (t === "thinking") {
    const text = typeof b.thinking === "string" ? b.thinking : "";
    return { type: "reasoning", text };
  }
  return b;
}
function sessionUsesTool(filePath, needle) {
  const lines = splitJsonlLines(readFileSync5(filePath, "utf8"));
  for (let i = 0;i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw.length === 0)
      continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    const content = record.content;
    if (!Array.isArray(content))
      continue;
    for (const block of content) {
      if (block === null || typeof block !== "object")
        continue;
      const b = block;
      if (b.type === "tool_use") {
        const toolName = typeof b.name === "string" ? b.name : "";
        if (toolName.toLowerCase().includes(needle))
          return true;
      }
    }
  }
  return false;
}
// ../../src/adapters/acpx.ts
import { existsSync as existsSync3, readFileSync as readFileSync6 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { join as join6, resolve as resolve5 } from "node:path";
var KNOWN_AGENTS = ["opencode", "codex", "claude"];
function createAcpxAdapter(entry, options = {}) {
  if (entry.agent !== "acpx") {
    throw new Error(`acpx adapter requires agent "acpx", got "${entry.agent}"`);
  }
  const basePath = resolveAcpxBasePath(options);
  const label = createLabel(entry);
  return {
    version: "1.0.0",
    listSessions: () => {
      const sessionsDir = join6(basePath, "sessions");
      if (!existsSync3(sessionsDir)) {
        return [];
      }
      const files = listJsonFiles(sessionsDir);
      const results = [];
      for (const filePath of files) {
        try {
          const session = parseAcpxSessionFile(filePath);
          results.push(mapToSessionSummary(session));
        } catch {}
      }
      return sortByIsoDesc(results, "updated_at");
    },
    searchSessions: (query) => {
      const sessionsDir = join6(basePath, "sessions");
      if (!existsSync3(sessionsDir)) {
        return [];
      }
      const files = listJsonFiles(sessionsDir);
      const needle = query.text.toLowerCase();
      const results = [];
      for (const filePath of files) {
        try {
          const session = parseAcpxSessionFile(filePath);
          const sessionIdMatch = containsIgnoreCase(session.sessionId, needle);
          const agentMatch = containsIgnoreCase(session.agent, needle);
          const scopeMatch = containsIgnoreCase(session.scope, needle);
          const nameMatch = session.name ? containsIgnoreCase(session.name, needle) : false;
          const promptMatch = session.last_prompt.some((p) => containsIgnoreCase(p.textPreview, needle) || containsIgnoreCase(p.timestamp, needle));
          if (sessionIdMatch || agentMatch || scopeMatch || nameMatch || promptMatch) {
            results.push(mapToSessionSummary(session));
          }
        } catch {}
      }
      return sortByIsoDesc(results, "updated_at");
    },
    getSessionDetail: async (sessionId, options2) => {
      const sessionsDir = join6(basePath, "sessions");
      if (!existsSync3(sessionsDir)) {
        throw new Error(`${label} sessions directory not found: ${sessionsDir}`);
      }
      const files = listJsonFiles(sessionsDir);
      for (const filePath of files) {
        try {
          const session = parseAcpxSessionFile(filePath);
          if (session.sessionId === sessionId) {
            let detail = mapToSessionDetail(session);
            const selection = options2.selection;
            let msgs = detail.messages ?? [];
            if (selection) {
              switch (selection.mode) {
                case "first":
                  msgs = msgs.slice(0, selection.count);
                  break;
                case "last":
                  msgs = selection.count === 0 ? [] : msgs.slice(-(selection.count ?? 10));
                  break;
                case "range": {
                  const start = (selection.start ?? 1) - 1;
                  const end = selection.end ?? start + 1;
                  msgs = msgs.slice(start, end);
                  break;
                }
                case "all":
                default:
                  break;
              }
            }
            const effectiveUserOnly = options2.userOnly || options2.selection?.userOnly;
            if (effectiveUserOnly) {
              if (options2.role && options2.role !== "user") {
                msgs = [];
              } else {
                msgs = msgs.filter((m) => m.role === "user");
              }
            } else if (options2.role) {
              msgs = msgs.filter((m) => m.role === options2.role);
            }
            detail = { ...detail, messages: msgs };
            return detail;
          }
        } catch {}
      }
      throw new Error(`${label} session not found: ${sessionId}`);
    },
    forkSession: async (sourceSessionId, destAgent, destAlias) => {
      return {
        newSessionId: `${destAgent}:${destAlias}:forked-${Date.now()}`,
        parentSessionId: sourceSessionId,
        destAgent,
        destAlias,
        forkedAt: new Date().toISOString()
      };
    },
    findSimilarSessions: async (_sessionId, _topK) => {
      return [
        {
          sessionId: "",
          title: "",
          score: 0,
          rank: 0,
          matchType: "none",
          matchedChunks: 0,
          note: "Not yet supported"
        }
      ];
    }
  };
}
function parseAcpxSessionFile(filePath) {
  let raw;
  try {
    raw = readFileSync6(filePath, "utf8");
  } catch (error) {
    throw new Error(`acpx: failed to read session file ${filePath}: ${errorMessage(error)}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`acpx: malformed JSON in session file ${filePath}`);
  }
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : basenameNoExt(filePath);
  const agent = typeof data.agent === "string" ? data.agent : "unknown";
  const scope = typeof data.scope === "string" ? data.scope : "";
  const name = typeof data.name === "string" && data.name.length > 0 ? data.name : null;
  const closed = data.closed === true;
  const pid = typeof data.pid === "number" ? data.pid : 0;
  const runtimeSessionId = typeof data.runtimeSessionId === "string" ? data.runtimeSessionId : null;
  const last_prompt = [];
  if (Array.isArray(data.last_prompt)) {
    for (const entry of data.last_prompt) {
      if (entry && typeof entry === "object") {
        const e = entry;
        if (e.role === "user" && typeof e.timestamp === "string") {
          last_prompt.push({
            role: "user",
            timestamp: e.timestamp,
            textPreview: typeof e.textPreview === "string" ? e.textPreview : ""
          });
        }
      }
    }
  }
  return { sessionId, agent, scope, name, closed, pid, runtimeSessionId, last_prompt };
}
function mapToSessionSummary(session) {
  const lastPrompt = session.last_prompt[session.last_prompt.length - 1];
  const agent = KNOWN_AGENTS.includes(session.agent) ? session.agent : "opencode";
  return {
    id: session.sessionId,
    agent,
    alias: session.name ?? session.scope,
    title: session.sessionId,
    created_at: session.last_prompt[0]?.timestamp ?? new Date(0).toISOString(),
    updated_at: lastPrompt?.timestamp ?? new Date(0).toISOString(),
    message_count: session.last_prompt.length,
    storage: "other"
  };
}
function mapToSessionDetail(session) {
  const messages = session.last_prompt.map((p, i) => ({
    id: `${session.sessionId}:${i}`,
    role: p.role,
    created_at: p.timestamp,
    parts: [
      {
        type: "text",
        text: p.textPreview
      }
    ]
  }));
  return {
    ...mapToSessionSummary(session),
    messages,
    warning: session.closed ? `Session is closed (pid: ${session.pid > 0 ? session.pid : "unknown"})` : undefined
  };
}
function resolveAcpxBasePath(options) {
  if (options.basePath) {
    return resolve5(options.basePath);
  }
  return join6(homedir5(), ".acpx");
}
function basenameNoExt(filePath) {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  const lastDot = base.lastIndexOf(".");
  return lastDot > 0 ? base.slice(0, lastDot) : base;
}
// ../../src/adapters/gemini.ts
import { readFileSync as readFileSync7 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { basename as basename2, join as join7 } from "node:path";
function createGeminiAdapter(entry, options = {}) {
  if (entry.agent !== "gemini") {
    throw new Error(`Gemini adapter requires agent "gemini", got "${entry.agent}"`);
  }
  return {
    version: "1.0.0",
    listSessions: () => {
      const label = createLabel(entry);
      try {
        const rootPath = resolveGeminiPath(entry, options);
        const files = collectJsonlFiles(rootPath);
        const results = [];
        for (const filePath of files) {
          try {
            results.push(parseGeminiSession(filePath, entry));
          } catch {}
        }
        return results;
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    searchSessions: (query) => {
      const label = createLabel(entry);
      try {
        const rootPath = resolveGeminiPath(entry, options);
        const files = collectJsonlFiles(rootPath);
        const needle = query.text.toLowerCase();
        const results = [];
        for (const filePath of files) {
          try {
            const session = parseGeminiSession(filePath, entry);
            const titleMatch = session.title.toLowerCase().includes(needle);
            const contentMatch = contentContains(filePath, needle);
            if (titleMatch || contentMatch) {
              results.push(session);
            }
          } catch {}
        }
        return sortByIsoDesc(results, "updated_at");
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    getSessionDetail: async (sessionId, readOptions) => {
      const label = createLabel(entry);
      const rootPath = resolveGeminiPath(entry, options);
      if (basename2(sessionId) !== sessionId || sessionId.includes("..")) {
        throw new Error(`${label} invalid session id: ${sessionId}`);
      }
      const directPath = join7(rootPath, sessionId + ".jsonl");
      const directStat = safeStat(directPath);
      let targetPath;
      if (directStat) {
        targetPath = directPath;
      } else {
        const files = collectJsonlFiles(rootPath);
        for (const filePath of files) {
          const summary2 = parseGeminiSession(filePath, entry);
          if (summary2.id === sessionId) {
            targetPath = filePath;
            break;
          }
        }
      }
      if (!targetPath) {
        throw new Error(`${label} session not found: ${sessionId}`);
      }
      const summary = parseGeminiSession(targetPath, entry);
      let messages = parseGeminiMessages(targetPath, label);
      if (readOptions.userOnly) {
        messages = messages.filter((m) => m.role === "user");
      }
      if (readOptions.selection) {
        const { mode, count, start, end } = readOptions.selection;
        if (mode === "last") {
          messages = count === 0 ? messages : messages.slice(-(count ?? 10));
        } else if (mode === "first") {
          messages = messages.slice(0, count ?? 10);
        } else if (mode === "range") {
          messages = messages.slice((start ?? 1) - 1, end ?? messages.length);
        }
      }
      return {
        ...summary,
        messages
      };
    },
    findSimilarSessions: async () => []
  };
}
function resolveGeminiPath(entry, options) {
  const home = options.homeDir ?? homedir6();
  const configured = typeof entry.path === "string" ? entry.path : undefined;
  const defaultPath = options.defaultPath ?? join7(home, ".gemini", "tmp");
  const resolved = resolvePath(configured ?? defaultPath);
  const stat = safeStat(resolved);
  if (!stat) {
    throw new Error(`Gemini path not found: ${resolved}`);
  }
  return resolved;
}
function parseGeminiSession(filePath, entry) {
  const content = readFileSync7(filePath, "utf8");
  const lines = splitJsonlLines(content);
  if (lines.length === 0) {
    throw new Error(`Gemini session file is empty: ${filePath}`);
  }
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`Gemini JSONL parse error in ${filePath} at line 1`);
  }
  const sessionId = header.sessionId || basename2(filePath, ".jsonl");
  let title;
  let messageCount = 0;
  let created_at = normalizeTimestamp(header.startTime, `Gemini timestamp invalid for ${sessionId} in ${filePath}`);
  let updated_at = normalizeTimestamp(header.lastUpdated || header.startTime, `Gemini timestamp invalid for ${sessionId} in ${filePath}`);
  for (let i = 1;i < lines.length; i++) {
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (record["$set"])
      continue;
    if (record.type === "user" || record.type === "gemini") {
      messageCount++;
      if (!title && record.type === "user") {
        title = extractContentLineGemini(record.content);
      }
    }
  }
  return {
    id: sessionId,
    agent: "gemini",
    alias: entry.alias,
    title: title || sessionId,
    created_at,
    updated_at,
    message_count: messageCount,
    storage: "jsonl"
  };
}
function parseGeminiMessages(filePath, label) {
  const content = readFileSync7(filePath, "utf8");
  const lines = splitJsonlLines(content);
  const messageMap = new Map;
  const messageOrder = [];
  for (let i = 1;i < lines.length; i++) {
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (record["$set"])
      continue;
    if (record.type !== "user" && record.type !== "gemini")
      continue;
    const id = record.id || `${filePath}:${i + 1}`;
    const context = `${label} timestamp invalid in ${filePath}:${i + 1}`;
    const created_at = normalizeTimestamp(record.timestamp, context);
    const parts = [];
    if (record.thoughts) {
      for (const thought of record.thoughts) {
        parts.push({
          type: "reasoning",
          text: `[${thought.subject}] ${thought.description}`
        });
      }
    }
    const textParts = extractContentPartsGemini(record.content);
    for (const text of textParts) {
      parts.push({ type: "text", text });
    }
    if (record.toolCalls) {
      for (const tc of record.toolCalls) {
        parts.push({
          type: "tool",
          tool: tc.name,
          state: {
            id: tc.id,
            args: tc.args,
            result: tc.result,
            status: tc.status
          }
        });
      }
    }
    const msg = {
      id,
      role: record.type === "gemini" ? "assistant" : "user",
      created_at,
      parts,
      modelID: record.model
    };
    if (record.tokens) {
      msg.tokens = record.tokens;
    }
    if (messageMap.has(id)) {
      messageMap.set(id, msg);
    } else {
      messageMap.set(id, msg);
      messageOrder.push(id);
    }
  }
  return messageOrder.map((id) => messageMap.get(id));
}
// ../../src/adapters/antigravity.ts
import { readFileSync as readFileSync8, readdirSync as readdirSync2 } from "node:fs";
import { homedir as homedir7 } from "node:os";
import { join as join8 } from "node:path";
var UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function createAntigravityAdapter(entry, options = {}) {
  if (entry.agent !== "antigravity") {
    throw new Error(`Antigravity adapter requires agent "antigravity", got "${entry.agent}"`);
  }
  return {
    version: "1.0.0",
    listSessions: () => {
      const label = createLabel(entry);
      try {
        const dataPath = resolveAntigravityPath(entry, options);
        const brainPath = join8(dataPath, "brain");
        const stat = safeStat(brainPath);
        if (!stat || !stat.isDirectory())
          return [];
        const uuids = readdirSync2(brainPath).filter((name) => UUID_REGEX.test(name));
        return uuids.map((uuid) => parseAntigravitySession(dataPath, uuid, entry));
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    searchSessions: (query) => {
      const label = createLabel(entry);
      try {
        const dataPath = resolveAntigravityPath(entry, options);
        const brainPath = join8(dataPath, "brain");
        const uuids = readdirSync2(brainPath).filter((name) => UUID_REGEX.test(name));
        const needle = query.text.toLowerCase();
        const results = [];
        for (const uuid of uuids) {
          const logPath = join8(dataPath, "brain", uuid, ".system_generated", "logs", "overview.txt");
          if (contentContains(logPath, needle)) {
            results.push(parseAntigravitySession(dataPath, uuid, entry));
          }
        }
        return sortByIsoDesc(results, "updated_at");
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    getSessionDetail: async (sessionId, readOptions) => {
      const label = createLabel(entry);
      const dataPath = resolveAntigravityPath(entry, options);
      const sessionPath = join8(dataPath, "brain", sessionId);
      if (!safeStat(sessionPath)) {
        throw new Error(`${label} session not found: ${sessionId}`);
      }
      const summary = parseAntigravitySession(dataPath, sessionId, entry);
      const logPath = join8(sessionPath, ".system_generated", "logs", "overview.txt");
      const stat = safeStat(logPath);
      if (!stat) {
        return { ...summary, messages: [] };
      }
      let messages = parseAntigravityMessages(logPath, label);
      if (readOptions.mode === "last_message") {
        messages = messages.slice(-1);
      } else if (readOptions.mode === "all_no_tools") {
        messages = messages.map((m) => ({
          ...m,
          parts: m.parts.filter((p) => p.type !== "tool")
        }));
      } else {
        const selection = readOptions.selection;
        if (selection) {
          switch (selection.mode) {
            case "first":
              messages = messages.slice(0, selection.count);
              break;
            case "last":
              messages = selection.count === 0 ? messages : messages.slice(-(selection.count ?? 10));
              break;
            case "range": {
              const start = (selection.start ?? 1) - 1;
              const end = selection.end ?? messages.length;
              messages = messages.slice(start, end);
              break;
            }
            case "all":
            default:
              break;
          }
        }
        const effectiveUserOnly = readOptions.userOnly || readOptions.selection?.userOnly;
        if (effectiveUserOnly) {
          if (readOptions.role && readOptions.role !== "user") {
            messages = [];
          } else {
            messages = messages.filter((m) => m.role === "user");
          }
        } else if (readOptions.role) {
          messages = messages.filter((m) => m.role === readOptions.role);
        }
      }
      return {
        ...summary,
        messages
      };
    },
    listSessionsByTimeRange: (opts) => {
      const label = createLabel(entry);
      try {
        const sinceMs = opts.since != null ? opts.since : 0;
        const untilMs = opts.until != null ? opts.until : 8640000000000000;
        const skipId = opts.skipSessionId;
        const dataPath = resolveAntigravityPath(entry, options);
        const brainPath = join8(dataPath, "brain");
        const stat = safeStat(brainPath);
        if (!stat || !stat.isDirectory())
          return [];
        const uuids = readdirSync2(brainPath).filter((name) => UUID_REGEX.test(name));
        let results = [];
        for (const uuid of uuids) {
          try {
            const session = parseAntigravitySession(dataPath, uuid, entry);
            if (skipId === session.id)
              continue;
            const updatedMs = Date.parse(session.updated_at);
            if (Number.isNaN(updatedMs))
              continue;
            if (updatedMs < sinceMs || updatedMs > untilMs)
              continue;
            results.push(session);
          } catch {}
        }
        results = sortByIsoDesc(results, "updated_at");
        if (opts.limit && opts.limit > 0) {
          results = results.slice(0, opts.limit);
        }
        return results;
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    toolSearchSessions: (query) => {
      const label = createLabel(entry);
      try {
        const needle = query.tool.toLowerCase();
        const dataPath = resolveAntigravityPath(entry, options);
        const brainPath = join8(dataPath, "brain");
        const stat = safeStat(brainPath);
        if (!stat || !stat.isDirectory())
          return [];
        const uuids = readdirSync2(brainPath).filter((name) => UUID_REGEX.test(name));
        const results = [];
        for (const uuid of uuids) {
          try {
            if (sessionUsesTool2(dataPath, uuid, needle)) {
              results.push(parseAntigravitySession(dataPath, uuid, entry));
            }
          } catch {}
        }
        return sortByIsoDesc(results, "updated_at");
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    forkSession: async (sourceSessionId, destAgent, destAlias) => {
      return {
        newSessionId: `agy-fork-${Date.now()}`,
        parentSessionId: sourceSessionId,
        destAgent,
        destAlias,
        forkedAt: new Date().toISOString()
      };
    },
    destroy: () => {},
    findSimilarSessions: async () => []
  };
}
function resolveAntigravityPath(entry, options) {
  const home = options.homeDir ?? homedir7();
  const configured = typeof entry.path === "string" ? entry.path : undefined;
  const defaultPath = options.dataPath ?? join8(home, ".gemini", "antigravity");
  const resolved = resolvePath(configured ?? defaultPath);
  const stat = safeStat(resolved);
  if (!stat) {
    throw new Error(`Antigravity path not found: ${resolved}`);
  }
  return resolved;
}
function parseAntigravitySession(dataPath, uuid, entry) {
  const logPath = join8(dataPath, "brain", uuid, ".system_generated", "logs", "overview.txt");
  const stat = safeStat(logPath);
  if (!stat) {
    const dirStat = safeStat(join8(dataPath, "brain", uuid));
    const mtime2 = dirStat?.mtime.toISOString() ?? new Date().toISOString();
    return {
      id: uuid,
      agent: "antigravity",
      alias: entry.alias,
      title: uuid,
      created_at: mtime2,
      updated_at: mtime2,
      message_count: 0,
      storage: "other"
    };
  }
  const content = readFileSync8(logPath, "utf8");
  const lines = splitJsonlLines(content);
  let title;
  let messageCount = 0;
  let firstTimestamp;
  let lastTimestamp;
  let parentSessionId;
  for (let i = 0;i < lines.length; i++) {
    let logEntry;
    try {
      logEntry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!parentSessionId && logEntry.parent_session_id) {
      parentSessionId = logEntry.parent_session_id;
    }
    const ts = normalizeTimestamp(logEntry.created_at, `Antigravity timestamp invalid in ${logPath}:${i + 1}`);
    if (!firstTimestamp)
      firstTimestamp = ts;
    lastTimestamp = ts;
    if (logEntry.source === "USER_EXPLICIT" && logEntry.type === "USER_INPUT") {
      messageCount++;
      if (!title && logEntry.content) {
        title = logEntry.content.split(/\r?\n/)[0].trim();
      }
    } else if (logEntry.source === "MODEL" && logEntry.type === "PLANNER_RESPONSE") {
      messageCount++;
    }
  }
  const mtime = stat.mtime.toISOString();
  return {
    id: uuid,
    agent: "antigravity",
    alias: entry.alias,
    title: title || uuid,
    created_at: firstTimestamp || mtime,
    updated_at: lastTimestamp || mtime,
    message_count: messageCount,
    storage: "other",
    ...parentSessionId ? { parentSessionId } : {}
  };
}
function parseAntigravityMessages(logPath, label) {
  const content = readFileSync8(logPath, "utf8");
  const lines = splitJsonlLines(content);
  const messages = [];
  for (let i = 0;i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.source === "USER_EXPLICIT" && entry.type === "USER_INPUT" || entry.source === "MODEL" && entry.type === "PLANNER_RESPONSE") {
      const created_at = normalizeTimestamp(entry.created_at, `${label} timestamp invalid in ${logPath}:${i + 1}`);
      const parts = [];
      if (entry.content) {
        parts.push({ type: "text", text: entry.content });
      }
      if (entry.reasoning) {
        parts.push({ type: "reasoning", text: entry.reasoning });
      }
      if (entry.tool_calls) {
        for (const tc of entry.tool_calls) {
          parts.push({
            type: "tool",
            tool: tc.name,
            state: { args: tc.args }
          });
        }
      }
      const message = {
        id: `step-${entry.step_index}-${i}`,
        role: entry.source === "MODEL" ? "assistant" : "user",
        created_at,
        parts
      };
      if (entry.model)
        message.modelID = entry.model;
      if (entry.agent)
        message.agent = entry.agent;
      messages.push(message);
    }
  }
  return messages;
}
function sessionUsesTool2(dataPath, uuid, needle) {
  const logPath = join8(dataPath, "brain", uuid, ".system_generated", "logs", "overview.txt");
  const stat = safeStat(logPath);
  if (!stat)
    return false;
  const content = readFileSync8(logPath, "utf8");
  const lines = splitJsonlLines(content);
  for (let i = 0;i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!entry.tool_calls)
      continue;
    for (const tc of entry.tool_calls) {
      const toolName = typeof tc.name === "string" ? tc.name : "";
      if (toolName.toLowerCase().includes(needle))
        return true;
    }
  }
  return false;
}
// ../../src/adapters/pi.ts
import { readFileSync as readFileSync9 } from "node:fs";
import { homedir as homedir8 } from "node:os";
import { basename as basename3, join as join9 } from "node:path";
function createPiAdapter(entry, options = {}) {
  if (entry.agent !== "pi") {
    throw new Error(`Pi adapter requires agent "pi", got "${entry.agent}"`);
  }
  return {
    version: "1.0.0",
    listSessions: () => {
      const label = createLabel(entry);
      try {
        const rootPath = resolvePiPath(entry, options);
        const sessionDirs = collectSessionDirs(rootPath);
        return sessionDirs.map((dirPath) => parsePiSession(dirPath, entry));
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    searchSessions: (query) => {
      const label = createLabel(entry);
      try {
        const rootPath = resolvePiPath(entry, options);
        const sessionDirs = collectSessionDirs(rootPath);
        const needle = query.text.toLowerCase();
        const results = [];
        for (const dirPath of sessionDirs) {
          try {
            const session = parsePiSession(dirPath, entry);
            const titleMatch = session.title.toLowerCase().includes(needle);
            const contentMatch = contentContains(dirPath, needle);
            if (titleMatch || contentMatch) {
              results.push(session);
            }
          } catch {}
        }
        return sortByIsoDesc(results, "updated_at");
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    getSessionDetail: async (sessionId, opts) => {
      const label = createLabel(entry);
      const rootPath = resolvePiPath(entry, options);
      const sessionDirs = collectSessionDirs(rootPath);
      for (const dirPath of sessionDirs) {
        const dirId = basename3(dirPath);
        if (dirId === sessionId) {
          let messages = parsePiMessages(dirPath, label);
          const summary = parsePiSession(dirPath, entry);
          if (opts.mode === "last_message") {
            messages = messages.slice(-1);
          } else if (opts.mode === "all_no_tools") {
            messages = messages.map((m) => ({
              ...m,
              parts: m.parts.filter((p) => p.type !== "tool")
            }));
          } else {
            const selection = opts.selection;
            if (selection) {
              switch (selection.mode) {
                case "first":
                  messages = messages.slice(0, selection.count);
                  break;
                case "last":
                  messages = selection.count === 0 ? messages : messages.slice(-(selection.count ?? 10));
                  break;
                case "range": {
                  const start = (selection.start ?? 1) - 1;
                  const end = selection.end ?? messages.length;
                  messages = messages.slice(start, end);
                  break;
                }
                case "all":
                default:
                  break;
              }
            }
            const effectiveUserOnly = opts.userOnly || opts.selection?.userOnly;
            if (effectiveUserOnly) {
              if (opts.role && opts.role !== "user") {
                messages = [];
              } else {
                messages = messages.filter((m) => m.role === "user");
              }
            } else if (opts.role) {
              messages = messages.filter((m) => m.role === opts.role);
            }
          }
          return { ...summary, messages };
        }
      }
      throw new Error(`${label} session not found: ${sessionId}`);
    },
    listSessionsByTimeRange: (opts) => {
      const label = createLabel(entry);
      try {
        const sinceMs = opts.since != null ? opts.since : 0;
        const untilMs = opts.until != null ? opts.until : 8640000000000000;
        const skipId = opts.skipSessionId;
        const rootPath = resolvePiPath(entry, options);
        const sessionDirs = collectSessionDirs(rootPath);
        let results = [];
        for (const dirPath of sessionDirs) {
          try {
            const session = parsePiSession(dirPath, entry);
            if (skipId === session.id)
              continue;
            const updatedMs = Date.parse(session.updated_at);
            if (Number.isNaN(updatedMs))
              continue;
            if (updatedMs < sinceMs || updatedMs > untilMs)
              continue;
            results.push(session);
          } catch {}
        }
        results = sortByIsoDesc(results, "updated_at");
        if (opts.limit && opts.limit > 0) {
          results = results.slice(0, opts.limit);
        }
        return results;
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    toolSearchSessions: (query) => {
      const label = createLabel(entry);
      try {
        const needle = query.tool.toLowerCase();
        const rootPath = resolvePiPath(entry, options);
        const sessionDirs = collectSessionDirs(rootPath);
        const results = [];
        for (const dirPath of sessionDirs) {
          try {
            if (sessionUsesTool3(dirPath, needle)) {
              results.push(parsePiSession(dirPath, entry));
            }
          } catch {}
        }
        return sortByIsoDesc(results, "updated_at");
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    forkSession: async (sourceSessionId, destAgent, destAlias) => {
      return {
        newSessionId: `pi-fork-${Date.now()}`,
        parentSessionId: sourceSessionId,
        destAgent,
        destAlias,
        forkedAt: new Date().toISOString()
      };
    },
    destroy: () => {},
    findSimilarSessions: async () => [
      {
        sessionId: "",
        title: "",
        score: 0,
        rank: 0,
        matchType: "none",
        matchedChunks: 0,
        note: "Not yet supported"
      }
    ]
  };
}
function resolvePiPath(entry, options) {
  const rawPath = entry.path;
  if (rawPath !== undefined && typeof rawPath !== "string") {
    throw new Error(`Pi path must be a non-empty string`);
  }
  if (typeof rawPath === "string" && rawPath.trim().length === 0) {
    throw new Error(`Pi path must be a non-empty string`);
  }
  const configured = typeof rawPath === "string" ? rawPath : undefined;
  const home = options.homeDir ?? homedir8();
  const defaultPath = options.defaultPath ?? join9(home, ".pi", "sessions");
  const resolved = resolvePath(configured ?? defaultPath, options.configDir);
  const stat = safeStat(resolved);
  if (!stat) {
    throw new Error(`Pi sessions path not found: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Pi sessions path is not a directory: ${resolved}`);
  }
  return resolved;
}
function collectSessionDirs(rootPath) {
  const dirs = [];
  const entries = safeStat(rootPath);
  if (!entries || !entries.isDirectory())
    return dirs;
  const { readdirSync: readdirSync3, statSync: statSync4 } = __require("node:fs");
  for (const name of readdirSync3(rootPath)) {
    if (name.startsWith("."))
      continue;
    const fullPath = join9(rootPath, name);
    try {
      if (statSync4(fullPath).isDirectory()) {
        const files = readdirSync3(fullPath).filter((f) => f.endsWith(".jsonl"));
        if (files.length > 0) {
          dirs.push(fullPath);
        }
      }
    } catch {}
  }
  return dirs;
}
function parsePiSession(dirPath, entry) {
  const sessionId = basename3(dirPath);
  const files = collectJsonlFiles(dirPath);
  let title;
  let messageCount = 0;
  let minTimestamp;
  let maxTimestamp;
  let parentSessionId;
  for (const filePath of files) {
    const lines = splitJsonlLines(readFileSync9(filePath, "utf8"));
    for (let i = 0;i < lines.length; i += 1) {
      const raw = lines[i].trim();
      if (raw.length === 0)
        continue;
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!parentSessionId) {
        parentSessionId = readOptionalString3(record.parentId);
      }
      if (record.timestamp) {
        const context = `Pi timestamp invalid for ${sessionId} at ${filePath}:${i + 1}`;
        const timestampIso = normalizeTimestamp(record.timestamp, context);
        minTimestamp = minTimestamp ? minIso(minTimestamp, timestampIso) : timestampIso;
        maxTimestamp = maxTimestamp ? maxIso(maxTimestamp, timestampIso) : timestampIso;
      }
      if (record.type === "message" && record.message) {
        messageCount += 1;
        if (!title && record.message.role === "user") {
          const content = record.message.content;
          if (Array.isArray(content)) {
            const textPart = content.find((c) => c.type === "text" && typeof c.text === "string" && c.text.length > 0);
            if (textPart?.text) {
              title = textPart.text.slice(0, 120);
            }
          } else if (typeof content === "string" && content.trim().length > 0) {
            title = content.slice(0, 120);
          }
        }
      }
    }
  }
  if (!minTimestamp || !maxTimestamp) {
    const { statSync: statSync4 } = __require("node:fs");
    try {
      const stat = statSync4(dirPath);
      const fallback = new Date(stat.mtimeMs).toISOString();
      minTimestamp = fallback;
      maxTimestamp = fallback;
    } catch {
      throw new Error(`Pi timestamps missing for ${sessionId} and cannot stat dir`);
    }
  }
  return {
    id: sessionId,
    agent: "pi",
    alias: entry.alias,
    title: title && title.length > 0 ? title : sessionId,
    created_at: minTimestamp,
    updated_at: maxTimestamp,
    message_count: messageCount,
    storage: "jsonl",
    ...parentSessionId ? { parentSessionId } : {}
  };
}
function readOptionalString3(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return;
}
function parsePiMessages(dirPath, label) {
  const files = collectJsonlFiles(dirPath);
  const messages = [];
  for (const filePath of files) {
    const lines = splitJsonlLines(readFileSync9(filePath, "utf8"));
    for (let i = 0;i < lines.length; i++) {
      const raw = lines[i].trim();
      if (raw.length === 0)
        continue;
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        continue;
      }
      if (record.type !== "message" || !record.message)
        continue;
      const role = record.message.role;
      if (role !== "user" && role !== "assistant")
        continue;
      const context = `${label} timestamp invalid in ${filePath}:${i + 1}`;
      const created_at = record.timestamp ? normalizeTimestamp(record.timestamp, context) : new Date().toISOString();
      const parts = [];
      const content = record.message.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          parts.push(mapContentPart(part));
        }
      } else if (typeof content === "string") {
        parts.push({ type: "text", text: content });
      }
      const message = {
        id: record.id ?? `${filePath}:${i + 1}`,
        role,
        created_at,
        parts
      };
      const modelID = readOptionalString3(record.message.model);
      const agentField = readOptionalString3(record.message.agent);
      if (modelID)
        message.modelID = modelID;
      if (agentField)
        message.agent = agentField;
      messages.push(message);
    }
  }
  return messages;
}
function mapContentPart(part) {
  const t = part.type;
  if (t === "text") {
    const text = "text" in part && typeof part.text === "string" ? part.text : "";
    return { type: "text", text };
  }
  if (t === "tool") {
    const p = part;
    return {
      type: "tool",
      tool: typeof p.tool === "string" ? p.tool : "",
      state: p.state ?? {}
    };
  }
  if (t === "reasoning") {
    const text = "text" in part && typeof part.text === "string" ? part.text : "";
    return { type: "reasoning", text };
  }
  return part;
}
function sessionUsesTool3(dirPath, needle) {
  const files = collectJsonlFiles(dirPath);
  for (const filePath of files) {
    const lines = splitJsonlLines(readFileSync9(filePath, "utf8"));
    for (let i = 0;i < lines.length; i += 1) {
      const raw = lines[i].trim();
      if (raw.length === 0)
        continue;
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        continue;
      }
      if (record.type !== "message" || !record.message)
        continue;
      const content = record.message.content;
      if (!Array.isArray(content))
        continue;
      for (const part of content) {
        if (part.type === "tool") {
          const toolName = part.tool ?? "";
          if (toolName.toLowerCase().includes(needle))
            return true;
        }
      }
    }
  }
  return false;
}
// ../../src/adapters/zcode.ts
import { homedir as homedir9 } from "node:os";
import { join as join10, resolve as resolve6 } from "node:path";
import { existsSync as existsSync4 } from "node:fs";
import { Database as DatabaseCtor } from "bun:sqlite";
var EXPECTED_TABLES = ["session", "message", "part"];
function validateSchema2(db, label) {
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  for (const t of EXPECTED_TABLES) {
    if (!tables.includes(t)) {
      throw new Error(`${label} schema mismatch: missing table "${t}"`);
    }
  }
}
function createZcodeAdapter(entry, options = {}) {
  if (entry.agent !== "zcode") {
    throw new Error(`zcode adapter requires agent "zcode", got "${entry.agent}"`);
  }
  const label = createLabel(entry);
  let db;
  let ownsDb = false;
  if (options.dbPath instanceof DatabaseCtor) {
    db = options.dbPath;
  } else {
    const resolvedPath = options.dbPath ? resolve6(options.dbPath) : join10(homedir9(), ".zcode", "cli", "db", "db.sqlite");
    if (!existsSync4(resolvedPath)) {
      throw new Error(`${label} database not found: ${resolvedPath}`);
    }
    db = new DatabaseCtor(resolvedPath, { readonly: true });
    ownsDb = true;
  }
  validateSchema2(db, label);
  return {
    version: "1.0.0",
    listSessions: () => {
      const rows = db.query("SELECT id, directory, title, time_created, time_updated, task_type, parent_id FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC").all();
      return rows.map((row) => mapSessionSummary(db, row, entry.alias)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    },
    listSessionsByTimeRange: (opts) => {
      const sinceMs = opts.since != null ? opts.since : 0;
      const untilMs = opts.until != null ? opts.until : 8640000000000000;
      const hasSkip = opts.skipSessionId != null;
      const effectiveLimit = opts.limit;
      const baseCols = "id, directory, title, time_created, time_updated, task_type, parent_id FROM session";
      const whereParts = ["time_archived IS NULL", "time_updated >= ?", "time_updated <= ?"];
      const params = [sinceMs, untilMs];
      if (hasSkip) {
        whereParts.push("id != ?");
        params.push(opts.skipSessionId);
      }
      const where = whereParts.join(" AND ");
      let sql;
      if (effectiveLimit) {
        sql = `SELECT ${baseCols} WHERE ${where} ORDER BY time_updated DESC LIMIT ?`;
        params.push(effectiveLimit);
      } else {
        sql = `SELECT ${baseCols} WHERE ${where} ORDER BY time_updated DESC`;
      }
      const rows = db.query(sql).all(...params);
      return rows.map((row) => mapSessionSummary(db, row, entry.alias)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    },
    searchSessions: (query) => {
      const needle = query.text.toLowerCase();
      const escaped = needle.replace(/%/g, "\\%").replace(/_/g, "\\_");
      const rows = db.query("SELECT id, directory, title, time_created, time_updated, task_type, parent_id FROM session WHERE time_archived IS NULL AND (LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(directory) LIKE ? ESCAPE '\\') ORDER BY time_updated DESC").all(`%${escaped}%`, `%${escaped}%`);
      const results = rows.map((row) => mapSessionSummary(db, row, entry.alias));
      return sortByIsoDesc(results, "updated_at");
    },
    getSessionDetail: async (sessionId, opts) => {
      const row = db.query("SELECT id, directory, title, time_created, time_updated, task_type, parent_id FROM session WHERE id = ?").get(sessionId);
      if (!row) {
        throw new Error(`${label} session not found: ${sessionId}`);
      }
      const summary = mapSessionSummary(db, row, entry.alias);
      const msgRows = db.query("SELECT id, session_id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC").all(sessionId);
      let messages = msgRows.map((m) => mapMessage(db, m));
      if (opts.mode === "last_message") {
        messages = messages.slice(-1);
      } else if (opts.mode === "all_no_tools") {
        messages = messages.map((m) => ({
          ...m,
          parts: m.parts.filter((p) => p.type !== "tool")
        }));
      } else {
        const selection = opts.selection;
        if (selection) {
          switch (selection.mode) {
            case "first":
              messages = messages.slice(0, selection.count);
              break;
            case "last":
              messages = selection.count === 0 ? messages : messages.slice(-(selection.count ?? 10));
              break;
            case "range": {
              const start = (selection.start ?? 1) - 1;
              const end = selection.end ?? messages.length;
              messages = messages.slice(start, end);
              break;
            }
            case "all":
            default:
              break;
          }
        }
        const effectiveUserOnly = opts.userOnly || opts.selection?.userOnly;
        if (effectiveUserOnly) {
          if (opts.role && opts.role !== "user") {
            messages = [];
          } else {
            messages = messages.filter((m) => m.role === "user");
          }
        } else if (opts.role) {
          messages = messages.filter((m) => m.role === opts.role);
        }
      }
      return { ...summary, messages };
    },
    toolSearchSessions: (query) => {
      const needle = query.tool.toLowerCase();
      const escaped = needle.replace(/%/g, "\\%").replace(/_/g, "\\_");
      const toolRows = db.query("SELECT DISTINCT session_id FROM tool_usage WHERE LOWER(tool_name) LIKE ? ESCAPE '\\'").all(`%${escaped}%`);
      const results = [];
      for (const tr of toolRows) {
        const row = db.query("SELECT id, directory, title, time_created, time_updated, task_type, parent_id FROM session WHERE time_archived IS NULL AND id = ?").get(tr.session_id);
        if (row) {
          results.push(mapSessionSummary(db, row, entry.alias));
        }
      }
      return sortByIsoDesc(results, "updated_at");
    },
    forkSession: async (sourceSessionId, destAgent, destAlias) => {
      return {
        newSessionId: `zcode-fork-${Date.now()}`,
        parentSessionId: sourceSessionId,
        destAgent,
        destAlias,
        forkedAt: new Date().toISOString()
      };
    },
    findSimilarSessions: async () => {
      return [];
    },
    destroy: () => {
      if (ownsDb) {
        db.close();
        ownsDb = false;
      }
    }
  };
}
var UNTITLED = "(untitled)";
function countMessages2(db, sessionId) {
  const row = db.query("SELECT COUNT(*) as c FROM message WHERE session_id = ?").get(sessionId);
  return row?.c ?? 0;
}
function mapSessionSummary(db, row, alias) {
  const title = row.title && row.title.length > 0 ? row.title : UNTITLED;
  return {
    id: row.id,
    agent: "zcode",
    alias,
    title,
    created_at: new Date(Number(row.time_created)).toISOString(),
    updated_at: new Date(Number(row.time_updated)).toISOString(),
    message_count: countMessages2(db, row.id),
    storage: "db",
    ...row.parent_id ? { parentSessionId: row.parent_id } : {}
  };
}
function mapMessage(db, row) {
  let parsed = {};
  try {
    parsed = JSON.parse(row.data);
  } catch {}
  const roleRaw = parsed.role ?? "user";
  const role = roleRaw === "assistant" || roleRaw === "system" ? roleRaw : "user";
  const createdMs = typeof parsed.time?.created === "number" ? parsed.time.created : Number(row.time_created);
  const modelID = parsed.model?.modelID ?? parsed.model?.id;
  const parts = mapParts(db, row.id);
  const message = {
    id: row.id,
    role,
    created_at: new Date(createdMs).toISOString(),
    parts
  };
  if (modelID)
    message.modelID = modelID;
  if (parsed.agent)
    message.agent = parsed.agent;
  return message;
}
function mapParts(db, messageId) {
  const rows = db.query("SELECT data FROM part WHERE message_id = ? ORDER BY sequence ASC, time_created ASC, id ASC").all(messageId);
  const parts = [];
  for (const r of rows) {
    let parsed;
    try {
      parsed = JSON.parse(r.data);
    } catch {
      continue;
    }
    const t = parsed.type;
    if (t === "text") {
      parts.push({ type: "text", text: typeof parsed.text === "string" ? parsed.text : "" });
    } else if (t === "tool") {
      parts.push({
        type: "tool",
        tool: typeof parsed.tool === "string" ? parsed.tool : "",
        state: parsed.state ?? {}
      });
    } else if (t === "reasoning") {
      parts.push({
        type: "reasoning",
        text: typeof parsed.text === "string" ? parsed.text : ""
      });
    } else {
      parts.push(parsed);
    }
  }
  return parts;
}
// ../../src/core/search.ts
async function searchSessions(registry, query) {
  const result = await searchSessionsWithErrors(registry, query);
  return result.sessions;
}
async function searchSessionsWithErrors(registry, query) {
  const sessions = [];
  const errors = [];
  const targetAdapters = registry.adapters.filter((a) => {
    if (query.agent && a.agent !== query.agent)
      return false;
    if (query.alias && a.alias !== query.alias)
      return false;
    return true;
  });
  const results = await Promise.all(targetAdapters.map(async (adapter) => {
    if (!adapter.searchSessions) {
      try {
        const all = await adapter.listSessions();
        const needle = query.text.toLowerCase();
        const matched = all.filter((s) => s.id.toLowerCase().includes(needle) || s.title.toLowerCase().includes(needle));
        return { adapter, sessions: matched };
      } catch (error) {
        return { adapter, error };
      }
    }
    try {
      const matched = await adapter.searchSessions(query);
      return { adapter, sessions: matched };
    } catch (error) {
      return { adapter, error };
    }
  }));
  for (const result of results) {
    if ("error" in result) {
      errors.push({
        agent: result.adapter.agent,
        alias: result.adapter.alias,
        message: errorMessage(result.error)
      });
      continue;
    }
    sessions.push(...result.sessions);
  }
  return {
    sessions: sessions.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
    errors
  };
}
// ../../src/sdk/session.ts
class AgentNotFoundError extends Error {
  constructor(agent) {
    super(`No adapter registered for agent: ${agent}`);
    this.name = "AgentNotFoundError";
  }
}

class AliasNotFoundError extends Error {
  constructor(agent, alias) {
    super(`No adapter registered for ${agent}:${alias}`);
    this.name = "AliasNotFoundError";
  }
}

class ForkNotSupportedError extends Error {
  constructor(agent, alias) {
    super(`Adapter ${agent}:${alias} does not implement forkSession — ` + `native write to agent storage is deferred until R-18`);
    this.name = "ForkNotSupportedError";
  }
}
async function forkSession(registry, source, dest) {
  const sourceHandle = findHandle(registry.adapters, source.agent, source.alias);
  if (!sourceHandle) {
    if (!hasAgent(registry.adapters, source.agent)) {
      throw new AgentNotFoundError(source.agent);
    }
    throw new AliasNotFoundError(source.agent, source.alias);
  }
  const destHandle = findHandle(registry.adapters, dest.agent, dest.alias);
  if (!destHandle) {
    if (!hasAgent(registry.adapters, dest.agent)) {
      throw new AgentNotFoundError(dest.agent);
    }
    throw new AliasNotFoundError(dest.agent, dest.alias);
  }
  let sourceDetail;
  if (sourceHandle.getSessionDetail) {
    try {
      sourceDetail = await sourceHandle.getSessionDetail(source.sessionId, {
        mode: "all_with_tools"
      });
    } catch (err) {
      sourceDetail = undefined;
    }
  }
  if (!destHandle.forkSession) {
    throw new ForkNotSupportedError(dest.agent, dest.alias);
  }
  const forkResult = await destHandle.forkSession(source.sessionId, dest.agent, dest.alias);
  if (!forkResult || typeof forkResult.newSessionId !== "string") {
    throw new Error(`${dest.agent}:${dest.alias} forkSession() returned invalid result: ` + `expected ForkResult with newSessionId string`);
  }
  return forkResult;
}
function findHandle(adapters, agent, alias) {
  return adapters.find((h) => h.agent === agent && h.alias === alias);
}
function hasAgent(adapters, agent) {
  return adapters.some((h) => h.agent === agent);
}

// ../../src/sdk/index.ts
var SDK_CONTRACT_VERSION = "0.1.0";
export {
  setWorkspaceFactories,
  searchSessionsWithErrors,
  searchSessions,
  resolveScope,
  parseConfigText,
  normalizeTimestamp,
  normalizeSessionSummary,
  loadConfigFromFile,
  invalidateDetailCache,
  forkSession,
  findGitRoot,
  createZcodeAdapter,
  createWorkspaceSession,
  createRegistry,
  createPiAdapter,
  createOpenCodeCloneDestinationAdapter,
  createOpenCodeAdapter,
  createGeminiAdapter,
  createCodexCloneSourceAdapter,
  createCodexAdapter,
  createClaudeAdapter,
  createAntigravityAdapter,
  createAdapterRegistry,
  createAdapter,
  createAcpxAdapter,
  clearDetailCache,
  buildCanonicalAlias,
  SDK_CONTRACT_VERSION
};
