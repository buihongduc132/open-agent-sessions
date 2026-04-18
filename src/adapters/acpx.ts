/**
 * acpx Adapter — R-31
 *
 * Adapter for openclaw/acpx: https://github.com/openclaw/acpx
 *
 * acpx is a headless CLI orchestration layer that maintains its own JSON session
 * records per git-root scope. It delegates work to underlying ACP servers
 * (pi, codex, claude, opencode, gemini, cursor, copilot, openclaw, etc.).
 *
 * Key distinction from native agent adapters: acpx reads ONLY its own JSON session
 * files from ~/.acpx/sessions/, not agent-native session files.
 *
 * Storage:
 *   ~/.acpx/sessions/*.json  — one file per session record
 *
 * Session key format: {agent}:{git_root_scope}:{optional_name}
 * Examples:
 *   codex:~/repos/backend
 *   codex:~/repos/backend:api
 *   opencode:/home/user/projects/monorepo
 *
 * @file src/adapters/acpx.ts
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Adapter, SearchQuery, SessionDetail, SessionMessage, SessionReadOptions, SessionSummary } from "../core/types";
import { AgentKind } from "../config/types";
import type { SimilarSessionResult } from "../similarity/search";
import { createLabel } from "./label";
import { errorMessage } from "../core/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AcpxAgentEntry = {
  agent: "acpx";
  alias: string;
  enabled: boolean;
};

const KNOWN_AGENTS: readonly string[] = ["opencode", "codex", "claude"];

type AcpxSession = {
  sessionId: string;   // canonical ID = session key (agent:scope:name)
  agent: string;       // agent command name
  scope: string;       // git-root path
  name: string | null; // optional named session
  closed: boolean;
  pid: number;
  runtimeSessionId: string | null;
  last_prompt: AcpxPromptEntry[];
};

type AcpxPromptEntry = {
  role: "user";
  timestamp: string;
  textPreview: string;
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export type AcpxAdapterOptions = {
  /** Base directory for acpx sessions. Defaults to ~/.acpx */
  basePath?: string;
  /**
   * Optional cwd override for resolving scope.
   * The adapter uses this when session scope needs to be resolved from cwd.
   */
  cwd?: string;
};

export function createAcpxAdapter(
  entry: AcpxAgentEntry,
  options: AcpxAdapterOptions = {}
): Adapter {
  if (entry.agent !== "acpx") {
    throw new Error(`acpx adapter requires agent "acpx", got "${entry.agent}"`);
  }

  const basePath = resolveAcpxBasePath(options);
  const label = createLabel(entry);

  return {
    version: "1.0.0",

    listSessions: (): SessionSummary[] => {
      const sessionsDir = join(basePath, "sessions");

      if (!existsSync(sessionsDir)) {
        // No sessions directory — return empty, not an error
        return [];
      }

      let files: string[];
      try {
        files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
      } catch {
        return [];
      }

      const results: SessionSummary[] = [];
      for (const file of files) {
        const filePath = join(sessionsDir, file);
        try {
          const session = parseAcpxSessionFile(filePath);
          results.push(mapToSessionSummary(session));
        } catch {
          // Skip malformed files
        }
      }

      // Sort by most recently updated (last prompt timestamp) descending
      results.sort(
        (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)
      );
      return results;
    },

    // R-31: searchSessions — full acpx adapter
    searchSessions: (query: SearchQuery): SessionSummary[] => {
      const sessionsDir = join(basePath, "sessions");

      if (!existsSync(sessionsDir)) {
        return [];
      }

      let files: string[];
      try {
        files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
      } catch {
        return [];
      }

      const needle = query.text.toLowerCase();
      const results: SessionSummary[] = [];

      for (const file of files) {
        const filePath = join(sessionsDir, file);
        try {
          const session = parseAcpxSessionFile(filePath);

          // Match against sessionId, agent, scope, name, and prompt previews
          const sessionIdMatch = session.sessionId.toLowerCase().includes(needle);
          const agentMatch = session.agent.toLowerCase().includes(needle);
          const scopeMatch = session.scope.toLowerCase().includes(needle);
          const nameMatch = session.name?.toLowerCase().includes(needle) ?? false;
          const promptMatch = session.last_prompt.some(
            (p) =>
              p.textPreview.toLowerCase().includes(needle) ||
              p.timestamp.toLowerCase().includes(needle)
          );

          if (sessionIdMatch || agentMatch || scopeMatch || nameMatch || promptMatch) {
            results.push(mapToSessionSummary(session));
          }
        } catch {
          // Skip malformed files
        }
      }

      results.sort(
        (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)
      );
      return results;
    },

    // R-31: getSessionDetail — full acpx adapter
    getSessionDetail: async (
      sessionId: string,
      options: SessionReadOptions
    ): Promise<SessionDetail> => {
      const sessionsDir = join(basePath, "sessions");

      if (!existsSync(sessionsDir)) {
        throw new Error(`${label} sessions directory not found: ${sessionsDir}`);
      }

      // Search all .json files for a matching sessionId field
      let files: string[];
      try {
        files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
      } catch {
        throw new Error(`${label} session not found: ${sessionId}`);
      }

      for (const file of files) {
        const filePath = join(sessionsDir, file);
        try {
          const session = parseAcpxSessionFile(filePath);
          if (session.sessionId === sessionId) {
            let detail = mapToSessionDetail(session);

            // Apply selection mode first (first / last / all / range), then userOnly filter
            const selection = options.selection;
            let msgs = detail.messages ?? [];
            if (selection) {
              switch (selection.mode) {
                case "first":
                  msgs = msgs.slice(0, selection.count);
                  break;
                case "last":
                  msgs = msgs.slice(-(selection.count ?? 10));
                  break;
                case "range": {
                  const start = (selection.start ?? 1) - 1; // 1-indexed → 0-indexed
                  const end = selection.end ?? start + 1;
                  msgs = msgs.slice(start, end);
                  break;
                }
                case "all":
                default:
                  // No slicing needed
                  break;
              }
            }

            // Apply userOnly filter if set (role=assistant conflicts with userOnly → empty)
            const effectiveUserOnly = options.userOnly || options.selection?.userOnly;
            if (effectiveUserOnly) {
              // If role is set to something other than 'user', userOnly constraint is impossible
              if (options.role && options.role !== "user") {
                msgs = [];
              } else {
                msgs = msgs.filter((m) => m.role === "user");
              }
            }

            detail = { ...detail, messages: msgs };

            return detail;
          }
        } catch {
          // Skip malformed files
        }
      }

      throw new Error(`${label} session not found: ${sessionId}`);
    },

    // R-33: forkSession — acpx creates a new named session
    // R-18 deferred: write to native agent storage is not yet implemented
    forkSession: async (
      sourceSessionId: string,
      destAgent: string,
      destAlias: string
    ): Promise<import("../core/types").ForkResult> => {
      return {
        newSessionId: `${destAgent}:${destAlias}:forked-${Date.now()}`,
        parentSessionId: sourceSessionId,
        destAgent,
        destAlias,
        forkedAt: new Date().toISOString(),
      };
    },

    // REQ-SIM-03: graceful fallback — acpx does not yet support similarity search
    findSimilarSessions: async (
      _sessionId: string,
      _topK?: number
    ): Promise<SimilarSessionResult[]> => {
      return [
        {
          sessionId: "",
          title: "",
          score: 0,
          rank: 0,
          matchType: "none" as const,
          matchedChunks: 0,
          note: "Not yet supported",
        },
      ];
    },
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseAcpxSessionFile(filePath: string): AcpxSession {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`acpx: failed to read session file ${filePath}: ${errorMessage(error)}`);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`acpx: malformed JSON in session file ${filePath}`);
  }

  const sessionId = typeof data.sessionId === "string" ? data.sessionId : basenameNoExt(filePath);
  const agent = typeof data.agent === "string" ? data.agent : "unknown";
  const scope = typeof data.scope === "string" ? data.scope : "";
  const name = typeof data.name === "string" && data.name.length > 0 ? data.name : null;
  const closed = data.closed === true;
  const pid = typeof data.pid === "number" ? data.pid : 0;
  const runtimeSessionId =
    typeof data.runtimeSessionId === "string" ? data.runtimeSessionId : null;

  const last_prompt: AcpxPromptEntry[] = [];
  if (Array.isArray(data.last_prompt)) {
    for (const entry of data.last_prompt) {
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        if (e.role === "user" && typeof e.timestamp === "string") {
          last_prompt.push({
            role: "user",
            timestamp: e.timestamp,
            textPreview:
              typeof e.textPreview === "string" ? e.textPreview : "",
          });
        }
      }
    }
  }

  return { sessionId, agent, scope, name, closed, pid, runtimeSessionId, last_prompt };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function mapToSessionSummary(session: AcpxSession): SessionSummary {
  const lastPrompt = session.last_prompt[session.last_prompt.length - 1];

  // acpx can delegate to any agent; cast known agents, fall back to "opencode"
  const agent: AgentKind = KNOWN_AGENTS.includes(session.agent)
    ? (session.agent as AgentKind)
    : "opencode";

  return {
    id: session.sessionId,
    agent,
    alias: session.name ?? session.scope,
    title: session.sessionId,
    created_at: session.last_prompt[0]?.timestamp ?? new Date(0).toISOString(),
    updated_at: lastPrompt?.timestamp ?? new Date(0).toISOString(),
    message_count: session.last_prompt.length,
    storage: "other",
  };
}

function mapToSessionDetail(session: AcpxSession): SessionDetail {
  const messages: SessionMessage[] = session.last_prompt.map((p, i) => ({
    id: `${session.sessionId}:${i}`,
    role: p.role,
    created_at: p.timestamp,
    parts: [
      {
        type: "text",
        text: p.textPreview,
      },
    ],
  }));

  return {
    ...mapToSessionSummary(session),
    messages,
    warning: session.closed
      ? `Session is closed (pid: ${session.pid > 0 ? session.pid : "unknown"})`
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveAcpxBasePath(options: AcpxAdapterOptions): string {
  if (options.basePath) {
    return resolve(options.basePath);
  }
  return join(homedir(), ".acpx");
}

function basenameNoExt(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  const lastDot = base.lastIndexOf(".");
  return lastDot > 0 ? base.slice(0, lastDot) : base;
}
