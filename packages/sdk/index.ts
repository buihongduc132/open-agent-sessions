// @open-agent-sessions/sdk — public adapter SDK boundary.
//
// Consumers (e.g. oas-command-stats) import adapter contracts from this scoped
// package instead of the internal src/core/types.ts path. Per OT1-G1/OT49 this
// establishes a versioned import surface: a breaking change to SessionDetail /
// Adapter / SessionSummary here is a SemVer-detectable break, whereas a change
// to the internal path was previously silent.
//
// The package re-exports the canonical SDK entrypoint verbatim (single source
// of truth in src/sdk/index.ts), so both `@open-agent-sessions/sdk` and the
// legacy `open-agent-sessions/sdk` subpath stay in lock-step.
export * from "../../src/sdk/index.ts";
