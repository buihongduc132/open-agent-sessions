export { loadConfigFromFile, parseConfigText } from "./load";
export { resolveOpenCodeStorage } from "./opencode";
export { validateConfig } from "./validate";

// Canonical config-path list — mirrors loadConfig() in bin/oas exactly so
// the CLI config command can print the same paths the runner will search.
export const configPaths: string[] = [
  "oas.config.yaml",
  "oas.config.yml",
  "~/.config/oas/config.yaml",
  "~/.config/oas/config.yml",
];

// Default config returned when no config file is found.
export const DEFAULT_CONFIG: Config = {
  agents: [
    {
      agent: "opencode",
      alias: "default",
      enabled: true,
      storage: { mode: "auto" },
    },
  ],
};
export type {
  AgentEntry,
  AgentKind,
  Config,
  OpenCodeAgentEntry,
  OpenCodeStorageConfig,
  OpenCodeStorageDefaults,
  OpenCodeStorageMode,
  OtherAgentEntry,
  ResolvedOpenCodeStorage,
} from "./types";
