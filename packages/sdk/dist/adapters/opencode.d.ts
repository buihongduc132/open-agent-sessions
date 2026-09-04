import { OpenCodeAgentEntry } from "../config/types";
import { Adapter } from "../core/types";
type OpenCodeAdapterOptions = {
    cwd?: string;
    lockRetries?: number[];
};
export declare function createOpenCodeAdapter(entry: OpenCodeAgentEntry, options?: OpenCodeAdapterOptions): Adapter;
import { CloneDestinationAdapter } from "../core/clone";
export interface OpenCodeCloneDestinationOptions {
    cwd?: string;
}
/**
 * Creates a CloneDestinationAdapter for OpenCode that writes to JSONL.
 * The adapter stores clone metadata in the session record.
 */
export declare function createOpenCodeCloneDestinationAdapter(entry: OpenCodeAgentEntry, options?: OpenCodeCloneDestinationOptions): CloneDestinationAdapter;
export {};
