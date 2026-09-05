/**
 * scripts/benchmark-cli-search.ts
 *
 * Empirical E2E Verification and Latency Benchmark Harness for Milestone 6:
 * CLI Surface, Formatting, Context Window, and Short IDs (bin/oas search).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { openSearchDb, closeSearchDb, initSearchSchema } from "../src/search/db";
import { syncSessionFile } from "../src/search/sync";

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function runProcess(
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
  }
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const cliPath = join(options.cwd, "bin", "oas");
    const proc = spawn("bun", [cliPath, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (exitCode) => {
      const durationMs = performance.now() - start;
      resolve({
        exitCode: exitCode ?? 0,
        stdout,
        stderr,
        durationMs,
      });
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

async function main() {
  console.log("================================================================================");
  console.log("Milestone 6 Empirical Challenger: CLI E2E Runner & Latency Benchmark (bin/oas)");
  console.log("================================================================================");

  const cwd = join(__dirname, "..");
  const tempDir = join(tmpdir(), `oas-cli-bench-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  const oasDir = join(tempDir, "oas");
  mkdirSync(oasDir, { recursive: true });
  const dbPath = join(oasDir, "search.sqlite");

  const sessionsDir = join(tempDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });

  // 1. Setup Test Database & Session Data
  console.log("\n[1/4] Seeding test database and session fixtures...");
  const db = openSearchDb({ dbPath });
  initSearchSchema(db);

  const session1Id = "01a05958-382a-4318-8f81-5421d0199e1a";
  const session1ShortId = "01a0595";
  const session1File = join(sessionsDir, "session-1.jsonl");
  const session1Turns = [
    { role: 1, timestamp: 1704067200000, content: "How do I deploy the production database migration?" },
    { role: 2, timestamp: 1704067210000, content: "You should run prisma migrate deploy in the server console." },
    { role: 2, timestamp: 1704067220000, toolCall: { name: "bash", arguments: { command: "prisma migrate deploy" } } },
    { role: 1, timestamp: 1704067260000, content: "The database migration completed successfully. What next?" },
    { role: 2, timestamp: 1704067270000, content: "Now verify the health endpoint and restart the api service." },
  ];
  writeFileSync(session1File, session1Turns.map((t) => JSON.stringify(t)).join("\n") + "\n");

  const session2Id = "7f9b1c2d-9481-4231-901a-83b271a06412";
  const session2ShortId = "7f9b1c2";
  const session2File = join(sessionsDir, "session-2.jsonl");
  const session2Turns = [
    { role: 1, timestamp: 1704153600000, content: "Please configure the nginx reverse proxy for authentication." },
    { role: 2, timestamp: 1704153610000, content: "I will configure the reverse proxy and deploy the auth server configuration." },
    { role: 2, timestamp: 1704153620000, toolCall: { name: "edit", arguments: { path: "/etc/nginx/sites-available/auth.conf" } } },
  ];
  writeFileSync(session2File, session2Turns.map((t) => JSON.stringify(t)).join("\n") + "\n");

  await syncSessionFile(db, { path: session1File, agent: "opencode", alias: "personal", sessionId: session1Id });
  await syncSessionFile(db, { path: session2File, agent: "claude", alias: "work", sessionId: session2Id });
  closeSearchDb(db);

  const env = {
    XDG_CACHE_HOME: tempDir,
    HOME: tempDir,
  };

  const failures: string[] = [];

  // 2. Empirical Verification of CLI Formatting & Invocations
  console.log("\n[2/4] Testing CLI search invocations and output formatting...");

  // Test 2.1: bin/oas search --text "keyword"
  console.log("  -> Invocations: bin/oas search --text \"deploy\"");
  const res1 = await runProcess(["search", "--text", "deploy"], { cwd, env });
  if (res1.exitCode !== 0) failures.push(`res1 exitCode ${res1.exitCode} != 0`);
  if (!/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(res1.stdout)) failures.push("res1 missing timestamp YYYY-MM-DD HH:mm:ss");
  if (!res1.stdout.includes("[opencode/personal]")) failures.push("res1 missing [opencode/personal]");
  if (!res1.stdout.includes(session1ShortId)) failures.push("res1 missing 7-char shortId " + session1ShortId);
  if (!/#\d+/.test(res1.stdout)) failures.push("res1 missing #turn");
  if (!res1.stdout.toLowerCase().includes("deploy")) failures.push("res1 missing matched snippet");
  console.log("     Output sample:\n" + res1.stdout.split("\n").slice(0, 2).map(l => "       " + l).join("\n"));

  // Test 2.2: bin/oas search --text "keyword" --context 2
  console.log("  -> Invocations: bin/oas search --text \"prisma migrate\" --context 2");
  const res2 = await runProcess(["search", "--text", "prisma migrate", "--context", "2"], { cwd, env });
  if (res2.exitCode !== 0) failures.push(`res2 exitCode ${res2.exitCode} != 0`);
  if (!res2.stdout.includes("▶ [hit]")) failures.push("res2 missing '▶ [hit]' delimiter");
  if (!res2.stdout.includes("│ [context]")) failures.push("res2 missing '│ [context]' delimiter");
  if (!res2.stdout.includes("#0")) failures.push("res2 context missing turn #0");
  if (!res2.stdout.includes("#1")) failures.push("res2 hit missing turn #1");
  if (!res2.stdout.includes("#2")) failures.push("res2 context missing turn #2");
  console.log("     Output sample:\n" + res2.stdout.split("\n").slice(0, 4).map(l => "       " + l).join("\n"));

  // Test 2.3: bin/oas search --text "keyword" --session <shortId>
  console.log("  -> Invocations: bin/oas search --text \"deploy\" --session " + session1ShortId);
  const res3 = await runProcess(["search", "--text", "deploy", "--session", session1ShortId], { cwd, env });
  if (res3.exitCode !== 0) failures.push(`res3 exitCode ${res3.exitCode} != 0`);
  if (!res3.stdout.includes(session1ShortId)) failures.push("res3 missing session1 shortId");
  if (res3.stdout.includes(session2ShortId)) failures.push("res3 incorrectly contains session2 shortId");
  if (res3.stdout.includes("nginx")) failures.push("res3 incorrectly contains session2 content");

  // Test 2.4: bin/oas search --text "keyword" --format json
  console.log("  -> Invocations: bin/oas search --text \"prisma\" --context 2 --format json");
  const res4 = await runProcess(["search", "--text", "prisma", "--context", "2", "--format", "json"], { cwd, env });
  if (res4.exitCode !== 0) failures.push(`res4 exitCode ${res4.exitCode} != 0`);
  let jsonHits: any[] = [];
  try {
    jsonHits = JSON.parse(res4.stdout);
    if (!Array.isArray(jsonHits)) failures.push("res4 JSON output is not an array");
    if (jsonHits.length === 0) failures.push("res4 JSON output is empty");
    const first = jsonHits[0];
    if (!first.sessionId) failures.push("res4 JSON missing sessionId");
    if (!first.shortId || first.shortId.length !== 7) failures.push("res4 JSON shortId length != 7");
    if (typeof first.turnIndex !== "number") failures.push("res4 JSON missing turnIndex number");
    if (!first.contextBefore || !Array.isArray(first.contextBefore)) failures.push("res4 JSON missing contextBefore array");
    if (!first.contextAfter || !Array.isArray(first.contextAfter)) failures.push("res4 JSON missing contextAfter array");
  } catch (err: any) {
    failures.push("res4 failed to parse JSON: " + err.message);
  }

  // Test 2.5: bin/oas search --text "keyword" --no-color
  console.log("  -> Invocations: bin/oas search --text \"deploy\" --no-color");
  const res5 = await runProcess(["search", "--text", "deploy", "--no-color"], { cwd, env });
  if (res5.exitCode !== 0) failures.push(`res5 exitCode ${res5.exitCode} != 0`);
  if (/\x1b\[[0-9;]*m/.test(res5.stdout)) failures.push("res5 contains ANSI escape sequences with --no-color");
  if (!res5.stdout.toLowerCase().includes("deploy")) failures.push("res5 missing snippet");

  // Test 2.6: Adversarial inputs
  console.log("  -> Invocations: Adversarial & edge cases (empty text, punctuation, nonexistent)");
  const resEmpty = await runProcess(["search", "--text", "   "], { cwd, env });
  if (resEmpty.exitCode !== 1) failures.push("resEmpty exitCode != 1");
  if (!resEmpty.stderr.includes("Missing required argument: --text")) failures.push("resEmpty stderr missing required text error");

  const resSpecial = await runProcess(["search", "--text", 'prisma "migrate" deploy: [prod]'], { cwd, env });
  if (resSpecial.exitCode !== 0) failures.push("resSpecial exitCode != 0 for quotes/brackets");

  const resNonexistent = await runProcess(["search", "--text", "nonexistent_token_xyz_999"], { cwd, env });
  if (resNonexistent.exitCode !== 0) failures.push("resNonexistent exitCode != 0");
  if (!resNonexistent.stdout.includes("No matches found.")) failures.push("resNonexistent stdout missing 'No matches found.'");

  if (failures.length > 0) {
    console.error("\n❌ CLI Formatting & Functional Verification FAILED with " + failures.length + " issues:");
    failures.forEach((f) => console.error("  - " + f));
    process.exit(1);
  } else {
    console.log("\n✅ All CLI formatting and functional verification checks PASSED cleanly!");
  }

  // 3. Subprocess CLI Latency Benchmarking
  console.log("\n[3/4] Benchmarking full CLI subprocess invocation latency (target < 100ms)...");
  const iterations = 30;
  const latencies: number[] = [];

  // Warmup run (JIT / filesystem cache)
  await runProcess(["search", "--text", "deploy", "--no-color"], { cwd, env });

  for (let i = 0; i < iterations; i++) {
    const res = await runProcess(["search", "--text", "deploy", "--no-color"], { cwd, env });
    latencies.push(res.durationMs);
  }

  latencies.sort((a, b) => a - b);
  const minMs = latencies[0];
  const maxMs = latencies[latencies.length - 1];
  const totalMs = latencies.reduce((sum, v) => sum + v, 0);
  const meanMs = totalMs / latencies.length;
  const p50Ms = latencies[Math.floor(latencies.length * 0.5)];
  const p90Ms = latencies[Math.floor(latencies.length * 0.9)];
  const p95Ms = latencies[Math.floor(latencies.length * 0.95)];

  console.log(`\n  Iterations: ${iterations} subprocess executions of 'bun bin/oas search --text "deploy" --no-color'`);
  console.log(`  Min latency:    ${minMs.toFixed(2)} ms`);
  console.log(`  Mean latency:   ${meanMs.toFixed(2)} ms`);
  console.log(`  p50 (Median):   ${p50Ms.toFixed(2)} ms`);
  console.log(`  p90 latency:    ${p90Ms.toFixed(2)} ms`);
  console.log(`  p95 latency:    ${p95Ms.toFixed(2)} ms`);
  console.log(`  Max latency:    ${maxMs.toFixed(2)} ms`);

  const latencyThresholdMs = 100;
  if (meanMs < latencyThresholdMs && p95Ms < latencyThresholdMs) {
    console.log(`\n✅ Latency Benchmark PASSED: Mean ${meanMs.toFixed(2)}ms and p95 ${p95Ms.toFixed(2)}ms are strictly below ${latencyThresholdMs}ms bound.`);
  } else {
    console.warn(`\n⚠️ Latency Warning: Mean ${meanMs.toFixed(2)}ms or p95 ${p95Ms.toFixed(2)}ms exceeded ${latencyThresholdMs}ms bound.`);
  }

  // Cleanup
  console.log("\n[4/4] Cleaning up temp directory...");
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error("Benchmark runner failed:", err);
  process.exit(1);
});
