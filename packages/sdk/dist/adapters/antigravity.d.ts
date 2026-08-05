import { OtherAgentEntry } from "../config/types";
import { Adapter } from "../core/types";
export type AntigravityAdapterOptions = {
    dataPath?: string;
    homeDir?: string;
};
export declare function createAntigravityAdapter(entry: OtherAgentEntry, options?: AntigravityAdapterOptions): Adapter;
