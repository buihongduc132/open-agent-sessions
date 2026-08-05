/**
 * src/cmd-usage/index.ts
 *
 * Public re-exports for the cmd-usage analyzer module.
 */

export { analyzeCmdUsage, encodeCwd } from "./analyzer";
export { classify, tokenize, splitCompound, stripPrefix, stripEnvAssign, basename, buildSignature, normalizeArgs } from "./classify";
export { extractBashCommands } from "./parser";
export type { RawBashCall } from "./parser";
export { AtuinEnricher } from "./enrichers/atuin-bridge";
export type { AtuinEnricherOptions } from "./enrichers/atuin-bridge";
export type { Enricher, EnricherQuery, EnricherResult } from "./enrichers/types";
export type {
  CmdMatch,
  CmdUsageRecord,
  CmdUsageReport,
  CmdUsageOptions,
  CmdUsageScope,
  EnricherStat,
} from "./types";
