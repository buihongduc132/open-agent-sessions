// @open-agent-sessions/sdk — public adapter SDK boundary.
//
// Consumers (e.g. oas-command-stats) import adapter contracts from this scoped
// package instead of the internal src/core/types.ts path. Per OT1-G1/OT49 this
// establishes a versioned import surface: a breaking change to SessionDetail /
// Adapter / SessionSummary here is a SemVer-detectable break, whereas a change
// to the internal path was previously silent.
//
 * The package publishes the built SDK entrypoint. Source remains canonical in
 * src/sdk/index.ts; the build output is the stable install boundary.
 */
export * from "../../src/sdk/index.ts";
