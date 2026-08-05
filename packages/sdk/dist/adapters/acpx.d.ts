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
import { Adapter } from "../core/types";
type AcpxAgentEntry = {
    agent: "acpx";
    alias: string;
    enabled: boolean;
};
export type AcpxAdapterOptions = {
    /** Base directory for acpx sessions. Defaults to ~/.acpx */
    basePath?: string;
    /**
     * Optional cwd override for resolving scope.
     * The adapter uses this when session scope needs to be resolved from cwd.
     */
    cwd?: string;
};
export declare function createAcpxAdapter(entry: AcpxAgentEntry, options?: AcpxAdapterOptions): Adapter;
export {};
