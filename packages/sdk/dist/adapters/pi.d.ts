import { OtherAgentEntry } from "../config/types";
import { Adapter } from "../core/types";
export type PiAdapterOptions = {
    defaultPath?: string;
    configDir?: string;
    homeDir?: string;
};
export declare function createPiAdapter(entry: OtherAgentEntry, options?: PiAdapterOptions): Adapter;
