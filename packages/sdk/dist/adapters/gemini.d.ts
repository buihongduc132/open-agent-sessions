import { OtherAgentEntry } from "../config/types";
import { Adapter } from "../core/types";
export type GeminiAdapterOptions = {
    defaultPath?: string;
    homeDir?: string;
};
export declare function createGeminiAdapter(entry: OtherAgentEntry, options?: GeminiAdapterOptions): Adapter;
