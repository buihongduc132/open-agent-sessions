import { OpenCodeAgentEntry, OpenCodeStorageDefaults, ResolvedOpenCodeStorage } from "./types";
export interface ResolveOpenCodeStorageOptions {
    exists?: (path: string) => boolean;
    context?: string;
}
export declare function resolveOpenCodeStorage(entry: OpenCodeAgentEntry, defaults: OpenCodeStorageDefaults, options?: ResolveOpenCodeStorageOptions): ResolvedOpenCodeStorage;
