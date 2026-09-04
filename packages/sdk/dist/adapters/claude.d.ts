import { OtherAgentEntry } from "../config/types";
import { Adapter } from "../core/types";
type ClaudeAdapterOptions = {
    defaultPath?: string;
    configDir?: string;
    homeDir?: string;
};
export declare function createClaudeAdapter(entry: OtherAgentEntry, options?: ClaudeAdapterOptions): Adapter;
export {};
