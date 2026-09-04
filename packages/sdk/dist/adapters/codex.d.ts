import { extractContentPartsCodex } from "./content-utils";
import { OtherAgentEntry } from "../config/types";
import { Adapter } from "../core/types";
import type { CloneSourceAdapter } from "../core/clone";
type CodexAdapterOptions = {
    defaultPath?: string;
    configDir?: string;
};
export declare function createCodexAdapter(entry: OtherAgentEntry, options?: CodexAdapterOptions): Adapter;
export { extractContentPartsCodex };
export interface CodexCloneSourceOptions {
    defaultPath?: string;
    configDir?: string;
}
/**
 * Creates a CloneSourceAdapter for Codex that reads from JSONL files.
 */
export declare function createCodexCloneSourceAdapter(entry: OtherAgentEntry, options?: CodexCloneSourceOptions): CloneSourceAdapter;
