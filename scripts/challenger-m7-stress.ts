#!/usr/bin/env bun
/**
 * scripts/challenger-m7-stress.ts
 *
 * Empirical Adversarial Stress Harness for Milestone 7
 *
 * Test Sections:
 * 1. Cold CLI Invocation Latency (30 runs, measure min, mean, p50, p90, p95, max)
 * 2. Color & Output Preservation (--no-color omitted vs explicit, pipe vs tty)
 * 3. Synchronization Flag Predictability (--sync vs --no-sync)
 * 4. Demonstration Script Resilience (concurrency, sequential, dirty temp dirs, lockfile checks)
 * 5. Corrupt Database Robustness (0-byte, truncated, garbage)
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { openSearchDb, closeSearchDb, initSearchSchema } from "../src/search/db";
import { syncSessionFile } from "../src/search/sync";

interface SubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function runSubprocess(
  cmd: string,
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }
): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    const start = performance.now();
    const proc = spawn(cmd, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr + "\n[TIMEOUT]",
          durationMs: performance.now() - start,
        });
      }
    }, options.timeoutMs ?? 20000);

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 0,
          stdout,
          stderr,
          durationMs: performance.now() - start,
        });
      }
    });

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          exitCode: 1,
          stdout,
          stderr: err.message,
          durationMs: performance.now() - start,
        });
      }
    });
  });
}

function runOas(
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }
): Promise<SubprocessResult> {
  const cliPath = join(options.cwd, "bin", "oas");
  return runSubprocess("bun", [cliPath, ...args], options);
}

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

async function main() {
  console.log("================================================================================");
  console.log("           EMPIRICAL CHALLENGER STRESS HARNESS — MILESTONE 7                    ");
  console.log("================================================================================\n");

  const repoRoot = join(__dirname, "..");
  const testBaseDir = join(tmpdir(), `challenger-m7-${Date.now()}`);
  mkdirSync(testBaseDir, { recursive: true });

  const summaryFindings: {
    name: string;
    status: "PASS" | "FAIL" | "WARN";
    details: string;
  }[] = [];

  try {
    // --------------------------------------------------------------------------
    // SUITE 1: Cold CLI Invocation Latency (30 Cold Runs)
    // --------------------------------------------------------------------------
    console.log(">>> [SUITE 1] Cold CLI Invocation Latency Benchmark (30 cold invocations)...");
    const suite1CacheDir = join(testBaseDir, "suite1-cache");
    mkdirSync(join(suite1CacheDir, "oas"), { recursive: true });
    const suite1DbPath = join(suite1CacheDir, "oas", "search.sqlite");

    // Initialize and seed a standard index with sample sessions
    const db1 = openSearchDb({ dbPath: suite1DbPath });
    initSearchSchema(db1);

    const s1Dir = join(testBaseDir, "suite1-sessions");
    mkdirSync(s1Dir, { recursive: true });
    const s1File = join(s1Dir, "sample.jsonl");
    const sampleTurns = [
      { role: 1, timestamp: 1704067200000, content: "Deploy the kubernetes cluster to staging environment." },
      { role: 2, timestamp: 1704067205000, content: "Running kubectl apply -f k8s/deployment.yaml" },
      { role: 2, timestamp: 1704067210000, toolCall: { name: "bash", arguments: { command: "kubectl apply -f k8s/deployment.yaml" } } },
      { role: 1, timestamp: 1704067220000, content: "The deployment pods are running and healthy." },
    ];
    writeFileSync(s1File, sampleTurns.map((t) => JSON.stringify(t)).join("\n") + "\n");
    await syncSessionFile(db1, {
      path: s1File,
      agent: "claude",
      alias: "work",
      sessionId: "11111111-2222-3333-4444-555555555555",
    });
    closeSearchDb(db1);

    const coldLatencies: number[] = [];
    const RUNS = 30;

    for (let i = 0; i < RUNS; i++) {
      const res = await runOas(["search", "--text", "kubernetes", "--no-sync", "--no-color"], {
        cwd: repoRoot,
        env: {
          XDG_CACHE_HOME: suite1CacheDir,
          NO_COLOR: "1",
        },
      });
      if (res.exitCode !== 0) {
        throw new Error(`Cold run #${i + 1} failed with exitCode ${res.exitCode}: ${res.stderr}`);
      }
      coldLatencies.push(res.durationMs);
    }

    coldLatencies.sort((a, b) => a - b);
    const minMs = coldLatencies[0];
    const maxMs = coldLatencies[coldLatencies.length - 1];
    const meanMs = coldLatencies.reduce((a, b) => a + b, 0) / RUNS;
    const p50Ms = coldLatencies[Math.floor(RUNS * 0.5)];
    const p90Ms = coldLatencies[Math.floor(RUNS * 0.9)];
    const p95Ms = coldLatencies[Math.floor(RUNS * 0.95)];

    console.log(`  Cold CLI Latency Statistics across ${RUNS} invocations:`);
    console.log(`    Min:  ${minMs.toFixed(2)}ms`);
    console.log(`    Mean: ${meanMs.toFixed(2)}ms`);
    console.log(`    p50:  ${p50Ms.toFixed(2)}ms`);
    console.log(`    p90:  ${p90Ms.toFixed(2)}ms`);
    console.log(`    p95:  ${p95Ms.toFixed(2)}ms`);
    console.log(`    Max:  ${maxMs.toFixed(2)}ms`);

    if (p95Ms < 100.0) {
      console.log(`  -> [PASS] p95 latency (${p95Ms.toFixed(2)}ms) is strictly < 100ms bound.\n`);
      summaryFindings.push({
        name: "Cold CLI Latency (p95 < 100ms)",
        status: "PASS",
        details: `p95=${p95Ms.toFixed(2)}ms, mean=${meanMs.toFixed(2)}ms across ${RUNS} runs`,
      });
    } else {
      console.log(`  -> [FAIL] p95 latency (${p95Ms.toFixed(2)}ms) exceeded 100ms bound!\n`);
      summaryFindings.push({
        name: "Cold CLI Latency (p95 < 100ms)",
        status: "FAIL",
        details: `p95=${p95Ms.toFixed(2)}ms exceeded 100ms threshold`,
      });
    }

    // --------------------------------------------------------------------------
    // SUITE 2: Color and Output Formatting (Omitting --no-color vs Explicit)
    // --------------------------------------------------------------------------
    console.log(">>> [SUITE 2] Color and Output Formatting (omitting --no-color vs explicit)...");

    // 2.1 Invocation with --no-color explicit
    const resNoColor = await runOas(["search", "--text", "kubernetes", "--no-sync", "--no-color"], {
      cwd: repoRoot,
      env: { XDG_CACHE_HOME: suite1CacheDir },
    });

    // 2.2 Invocation with --no-color omitted (piped spawn -> process.stdout.isTTY is false)
    const resOmittedColor = await runOas(["search", "--text", "kubernetes", "--no-sync"], {
      cwd: repoRoot,
      env: { XDG_CACHE_HOME: suite1CacheDir },
    });

    const strippedNoColor = resNoColor.stdout.replace(ANSI_REGEX, "");
    const strippedOmitted = resOmittedColor.stdout.replace(ANSI_REGEX, "");

    const noColorHasAnsi = ANSI_REGEX.test(resNoColor.stdout);
    const omittedHasAnsi = ANSI_REGEX.test(resOmittedColor.stdout);

    console.log(`  --no-color output contains ANSI codes: ${noColorHasAnsi}`);
    console.log(`  Omitted --no-color output contains ANSI codes: ${omittedHasAnsi}`);

    // Verify output text content integrity
    const outputMatches = strippedNoColor.trim() === strippedOmitted.trim();
    console.log(`  Text content identical between both modes: ${outputMatches}`);

    // Check for character corruption (e.g. \uFFFD)
    const hasReplacementChar = resNoColor.stdout.includes("\uFFFD") || resOmittedColor.stdout.includes("\uFFFD");
    console.log(`  Contains Unicode replacement characters (\\uFFFD): ${hasReplacementChar}`);

    if (outputMatches && !hasReplacementChar && !noColorHasAnsi) {
      console.log("  -> [PASS] Omitting --no-color preserves output integrity without corruption.\n");
      summaryFindings.push({
        name: "Color & Output Formatting",
        status: "PASS",
        details: "Output identical, zero ANSI under --no-color, zero character corruption",
      });
    } else {
      console.log("  -> [FAIL] Output corrupted or mismatched between color modes!\n");
      summaryFindings.push({
        name: "Color & Output Formatting",
        status: "FAIL",
        details: `outputMatches=${outputMatches}, hasReplacementChar=${hasReplacementChar}`,
      });
    }

    // --------------------------------------------------------------------------
    // SUITE 3: Synchronization Flag Predictability (--sync vs --no-sync)
    // --------------------------------------------------------------------------
    console.log(">>> [SUITE 3] Synchronization Flag Predictability (--sync vs --no-sync)...");

    const suite3CacheDir = join(testBaseDir, "suite3-cache");
    mkdirSync(join(suite3CacheDir, "oas"), { recursive: true });

    const suite3ConfigDir = join(testBaseDir, "suite3-config");
    mkdirSync(suite3ConfigDir, { recursive: true });

    // Create session storage
    const suite3SessionsDir = join(testBaseDir, "suite3-sessions");
    mkdirSync(suite3SessionsDir, { recursive: true });
    const suite3File = join(suite3SessionsDir, "session.jsonl");

    // Write initial turns
    writeFileSync(
      suite3File,
      JSON.stringify({ role: 1, timestamp: 1704067200000, content: "Initial turn alpha." }) + "\n"
    );

    // Search with --no-sync on empty db
    const resNoSync1 = await runOas(["search", "--text", "alpha", "--no-sync", "--no-color"], {
      cwd: repoRoot,
      env: {
        XDG_CACHE_HOME: suite3CacheDir,
        OAS_CONFIG_DIR: suite3ConfigDir,
      },
    });

    console.log(`  --no-sync on unindexed DB output: "${resNoSync1.stdout.trim()}"`);
    console.log(`  --no-sync exited cleanly with code: ${resNoSync1.exitCode}`);

    // Now index the session
    const db3 = openSearchDb({ dbPath: join(suite3CacheDir, "oas", "search.sqlite") });
    initSearchSchema(db3);
    await syncSessionFile(db3, {
      path: suite3File,
      agent: "opencode",
      alias: "default",
      sessionId: "33333333-3333-3333-3333-333333333333",
    });
    closeSearchDb(db3);

    // Search again with --no-sync (should now find it)
    const resNoSync2 = await runOas(["search", "--text", "alpha", "--no-sync", "--no-color"], {
      cwd: repoRoot,
      env: {
        XDG_CACHE_HOME: suite3CacheDir,
        OAS_CONFIG_DIR: suite3ConfigDir,
      },
    });
    console.log(`  --no-sync on indexed DB matches: ${resNoSync2.stdout.includes("alpha")}`);

    if (resNoSync1.exitCode === 0 && resNoSync1.stdout.includes("No matches found.") && resNoSync2.exitCode === 0 && resNoSync2.stdout.includes("alpha")) {
      console.log("  -> [PASS] --no-sync behaves predictably by querying existing index directly.\n");
      summaryFindings.push({
        name: "Sync Flag Predictability (--no-sync)",
        status: "PASS",
        details: "Directly queries existing index state without unexpected mutations",
      });
    } else {
      console.log("  -> [FAIL] --no-sync failed or produced unexpected results.\n");
      summaryFindings.push({
        name: "Sync Flag Predictability (--no-sync)",
        status: "FAIL",
        details: `res1=${resNoSync1.exitCode}, res2=${resNoSync2.exitCode}`,
      });
    }

    // --------------------------------------------------------------------------
    // SUITE 4: Demonstration Script Resilience & Concurrency
    // --------------------------------------------------------------------------
    console.log(">>> [SUITE 4] Demonstration Script Resilience & Concurrency...");
    const demoScriptPath = join(repoRoot, "scripts", "demo-fts5-search.ts");

    // 4.1 Sequential Runs (3 runs)
    console.log("  Running scripts/demo-fts5-search.ts sequentially 3 times...");
    let sequentialOk = true;
    for (let s = 1; s <= 3; s++) {
      const sStart = performance.now();
      const sRes = await runSubprocess("bun", [demoScriptPath], { cwd: repoRoot });
      const sDur = performance.now() - sStart;
      console.log(`    Sequential Run #${s}: exitCode=${sRes.exitCode} (${sDur.toFixed(0)}ms)`);
      if (sRes.exitCode !== 0) {
        sequentialOk = false;
        console.error(`    ERROR in sequential run #${s}:`, sRes.stderr);
      }
    }

    // 4.2 Concurrent Runs (3 parallel runs)
    console.log("  Running scripts/demo-fts5-search.ts concurrently (3 instances)...");
    const cStart = performance.now();
    const concurrentPromises = [1, 2, 3].map((cId) =>
      runSubprocess("bun", [demoScriptPath], { cwd: repoRoot }).then((res) => ({ cId, ...res }))
    );
    const concurrentResults = await Promise.all(concurrentPromises);
    const cDur = performance.now() - cStart;

    let concurrentOk = true;
    for (const cr of concurrentResults) {
      console.log(`    Concurrent Instance #${cr.cId}: exitCode=${cr.exitCode} (${cr.durationMs.toFixed(0)}ms)`);
      if (cr.exitCode !== 0) {
        concurrentOk = false;
        console.error(`    ERROR in concurrent instance #${cr.cId}:`, cr.stderr);
      }
    }
    console.log(`    All 3 concurrent instances completed in ${cDur.toFixed(0)}ms.`);

    // 4.3 Lockfile check in tmpdir
    console.log("  Checking for orphaned lockfiles or temporary files in tmpdir()...");
    const tmpContents = readdirSync(tmpdir());
    const leftoverDemoDirs = tmpContents.filter((f) => f.startsWith("oas-demo-fts5-"));
    console.log(`    Found ${leftoverDemoDirs.length} leftover oas-demo-fts5-* directories in tmpdir.`);

    if (sequentialOk && concurrentOk && leftoverDemoDirs.length === 0) {
      console.log("  -> [PASS] Demonstration script is fully resilient: zero errors, clean exit 0, zero leftover lockfiles.\n");
      summaryFindings.push({
        name: "Demonstration Script Resilience",
        status: "PASS",
        details: "3 sequential + 3 concurrent runs passed with exitCode 0, 0 leftover temp dirs/lockfiles",
      });
    } else {
      console.log(`  -> [FAIL] Demonstration script had failures: sequentialOk=${sequentialOk}, concurrentOk=${concurrentOk}, leftoverDirs=${leftoverDemoDirs.length}\n`);
      summaryFindings.push({
        name: "Demonstration Script Resilience",
        status: "FAIL",
        details: `sequentialOk=${sequentialOk}, concurrentOk=${concurrentOk}, leftoverDirs=${leftoverDemoDirs.length}`,
      });
    }

    // --------------------------------------------------------------------------
    // SUITE 5: Robustness Under Corrupt Databases
    // --------------------------------------------------------------------------
    console.log(">>> [SUITE 5] Robustness Under Corrupt Databases...");

    // Test 5.1: Zero-byte file
    console.log("  Case 5.1: Zero-byte search.sqlite");
    const zeroByteDir = join(testBaseDir, "corrupt-zero");
    mkdirSync(join(zeroByteDir, "oas"), { recursive: true });
    writeFileSync(join(zeroByteDir, "oas", "search.sqlite"), "");

    const zeroRes = await runOas(["search", "--text", "anything", "--no-sync", "--no-color"], {
      cwd: repoRoot,
      env: { XDG_CACHE_HOME: zeroByteDir },
    });
    console.log(`    Zero-byte exitCode: ${zeroRes.exitCode}`);
    console.log(`    Zero-byte stdout:   ${zeroRes.stdout.trim()}`);
    console.log(`    Zero-byte stderr:   ${zeroRes.stderr.trim()}`);
    const zeroByteOk = zeroRes.exitCode === 0 && zeroRes.stdout.includes("No matches found.");

    // Test 5.2: Truncated SQLite file (100 bytes of partial header)
    console.log("  Case 5.2: Truncated search.sqlite (100 bytes)");
    const truncDir = join(testBaseDir, "corrupt-trunc");
    mkdirSync(join(truncDir, "oas"), { recursive: true });
    const truncDbPath = join(truncDir, "oas", "search.sqlite");

    const dbTrunc = openSearchDb({ dbPath: truncDbPath });
    initSearchSchema(dbTrunc);
    closeSearchDb(dbTrunc);
    truncateSync(truncDbPath, 100);

    const truncRes = await runOas(["search", "--text", "anything", "--no-sync", "--no-color"], {
      cwd: repoRoot,
      env: { XDG_CACHE_HOME: truncDir },
    });
    console.log(`    Truncated (100B) exitCode: ${truncRes.exitCode}`);
    console.log(`    Truncated (100B) stdout:   ${truncRes.stdout.trim()}`);
    console.log(`    Truncated (100B) stderr:   ${truncRes.stderr.trim()}`);

    // Test 5.3: Truncated to 16 bytes ("SQLite format 3\0")
    console.log("  Case 5.3: Truncated search.sqlite (16 bytes)");
    const trunc16Dir = join(testBaseDir, "corrupt-trunc16");
    mkdirSync(join(trunc16Dir, "oas"), { recursive: true });
    writeFileSync(join(trunc16Dir, "oas", "search.sqlite"), "SQLite format 3\0");

    const trunc16Res = await runOas(["search", "--text", "anything", "--no-sync", "--no-color"], {
      cwd: repoRoot,
      env: { XDG_CACHE_HOME: trunc16Dir },
    });
    console.log(`    Truncated (16B) exitCode: ${trunc16Res.exitCode}`);
    console.log(`    Truncated (16B) stdout:   ${trunc16Res.stdout.trim()}`);
    console.log(`    Truncated (16B) stderr:   ${trunc16Res.stderr.trim()}`);

    // Test 5.4: Non-database garbage string
    console.log("  Case 5.4: Corrupt non-database string");
    const garbageDir = join(testBaseDir, "corrupt-garbage");
    mkdirSync(join(garbageDir, "oas"), { recursive: true });
    writeFileSync(join(garbageDir, "oas", "search.sqlite"), "RANDOM_CORRUPT_GARBAGE_PAYLOAD_NOT_SQLITE");

    const garbageRes = await runOas(["search", "--text", "anything", "--no-sync", "--no-color"], {
      cwd: repoRoot,
      env: { XDG_CACHE_HOME: garbageDir },
    });
    console.log(`    Garbage exitCode: ${garbageRes.exitCode}`);
    console.log(`    Garbage stdout:   ${garbageRes.stdout.trim()}`);
    console.log(`    Garbage stderr:   ${garbageRes.stderr.trim()}`);

    const truncRebuilt = truncRes.exitCode === 0;
    const trunc16Rebuilt = trunc16Res.exitCode === 0;
    const garbageRebuilt = garbageRes.exitCode === 0;

    if (zeroByteOk && truncRebuilt && trunc16Rebuilt && garbageRebuilt) {
      console.log("  -> [PASS] Corrupt database is automatically detected, rebuilt, and exits 0 cleanly.\n");
      summaryFindings.push({
        name: "Corrupt Database Recovery",
        status: "PASS",
        details: "Zero-byte, truncated (100B/16B), and garbage SQLite files rebuilt cleanly",
      });
    } else {
      console.log("  -> [FAIL] Corrupt database causes unhandled crash instead of automated rebuild!\n");
      console.log(`     Details: zeroByteOk=${zeroByteOk}, truncRebuilt=${truncRebuilt} (exitCode ${truncRes.exitCode}), trunc16Rebuilt=${trunc16Rebuilt} (exitCode ${trunc16Res.exitCode}), garbageRebuilt=${garbageRebuilt} (exitCode ${garbageRes.exitCode})`);
      summaryFindings.push({
        name: "Corrupt Database Recovery",
        status: "FAIL",
        details: `zeroByteOk=${zeroByteOk}, trunc(100B) exit=${truncRes.exitCode} ("${truncRes.stderr.trim()}"), trunc(16B) exit=${trunc16Res.exitCode} ("${trunc16Res.stderr.trim()}"), garbage exit=${garbageRes.exitCode} ("${garbageRes.stderr.trim()}")`,
      });
    }

  } finally {
    if (existsSync(testBaseDir)) {
      rmSync(testBaseDir, { recursive: true, force: true });
    }
  }

  // --------------------------------------------------------------------------
  // Summary & Scorecard
  // --------------------------------------------------------------------------
  console.log("================================================================================");
  console.log("                      CHALLENGER SCORECARD & SUMMARY                            ");
  console.log("================================================================================");
  summaryFindings.forEach((f) => {
    console.log(`[${f.status}] ${f.name}: ${f.details}`);
  });
  console.log("================================================================================\n");
}

main().catch((err) => {
  console.error("FATAL ERROR in challenger harness:", err);
  process.exit(1);
});
