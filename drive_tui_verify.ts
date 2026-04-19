// drive_tui_verify.ts — waits for sessions to load, then verifies tree/timeline views
// Uses raw PTY + simple ANSI stripper so we can see actual text content
import { spawn } from "node:child_process";

const ROWS = 40, COLS = 160;

const proc = spawn("oas", ["tui"], {
  cwd: "/home/bhd/Documents/Projects/bhd/open-agent-sessions",
  env: { ...process.env, TERM: "xterm-256color" },
  rows: ROWS,
  cols: COLS,
});

let frameBuffer = "";
let lastUpdate = Date.now();
let done = false;
let interactionPhase = 0;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Strip ANSI escape sequences, return clean screen lines
function stripAnsi(raw: string): string[] {
  const lines = raw.split("\n").map(l => l.trimEnd());
  // Filter to lines that have visible ASCII content (skip pure escape noise)
  const visible = lines.filter(l => {
    const stripped = l.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/[^\x20-\x7e]/g, " ").trim();
    return stripped.length > 0 && !/^\s*$/.test(stripped);
  });
  return visible;
}

function parseSimple(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[[^m]*m/g, "")
    .replace(/[\x00-\x1f]/g, "")
    .trim();
}

async function sendKey(key: string) {
  return new Promise<void>((resolve) => {
    proc.stdin.write(key, () => { resolve(); });
  });
}

async function main() {
  console.log("Starting oas tui...");
  console.log("Waiting for sessions to load (may take 60+ seconds due to 6185 codex files)...\n");

  let bootFrames = 0;
  let lastLen = 0;

  proc.stdout.on("data", (chunk: Buffer) => {
    frameBuffer += chunk.toString("utf8");
    lastUpdate = Date.now();
    bootFrames++;
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    const txt = chunk.toString();
    if (txt.includes("DEBUG")) process.stderr.write(txt);
  });

  // Wait for substantial output (multiple frames = real content)
  let waited = 0;
  while (waited < 90000) {
    await sleep(2000);
    waited += 2000;
    const len = frameBuffer.length;
    const delta = len - lastLen;
    lastLen = len;
    console.log(`  t=${waited}s: ${bootFrames} frames, ${len} buffer chars, delta=${delta}`);
    // After 10s, look for actual session content
    if (waited >= 15000 && delta > 100) break;
    if (waited >= 60000 && len > 500) break;
  }

  // ── PHASE 0: Show initial list view ──
  console.log("\n=== PHASE 0: INITIAL LIST VIEW ===");
  const lines0 = stripAnsi(frameBuffer);
  console.log(`Visible content lines: ${lines0.length}`);
  lines0.slice(0, 30).forEach((l, i) => console.log(`${i + 1}| ${l}`));

  // ── PHASE 1: Press Tab → switch to tree view ──
  console.log("\n>>> [1] Pressing Tab → tree view");
  await sendKey("\t");
  await sleep(3000);

  const bufAfterTab = frameBuffer.slice(frameBuffer.length - 2000);
  const lines1 = stripAnsi(bufAfterTab);
  console.log(`\n=== PHASE 1: AFTER Tab (tree) ===`);
  console.log(`New content lines: ${lines1.length}`);
  lines1.forEach((l, i) => console.log(`${i + 1}| ${l}`));

  // Check for codex sessions in tree
  const treeContent = parseSimple(bufAfterTab);
  const hasCodex = treeContent.toLowerCase().includes("codex");
  const hasOpencode = treeContent.toLowerCase().includes("opencode");
  console.log(`\n>>> TREE VIEW CHECK:`);
  console.log(`  codex present: ${hasCodex}`);
  console.log(`  opencode present: ${hasOpencode}`);

  // Look for session IDs
  const idMatches = treeContent.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi) || [];
  console.log(`  session IDs found: ${idMatches.slice(0, 5).join(", ")}${idMatches.length > 5 ? " ..." : ""} (${idMatches.length} total)`);

  // ── PHASE 2: Press Enter on first session ──
  if (hasCodex || hasOpencode) {
    console.log("\n>>> [2] Pressing Enter → open detail");
    await sendKey("\n");
    await sleep(3000);

    const bufAfterEnter = frameBuffer.slice(frameBuffer.length - 2000);
    const lines2 = stripAnsi(bufAfterEnter);
    console.log(`\n=== PHASE 2: AFTER Enter (detail/tree) ===`);
    console.log(`New content lines: ${lines2.length}`);
    lines2.forEach((l, i) => console.log(`${i + 1}| ${l}`));

    // ── PHASE 3: Press t → timeline view ──
    console.log("\n>>> [3] Pressing t → timeline view");
    await sendKey("t");
    await sleep(3000);

    const bufAfterT = frameBuffer.slice(frameBuffer.length - 2000);
    const lines3 = stripAnsi(bufAfterT);
    console.log(`\n=== PHASE 3: AFTER t (timeline) ===`);
    console.log(`New content lines: ${lines3.length}`);
    lines3.forEach((l, i) => console.log(`${i + 1}| ${l}`));

    // ── PHASE 4: Press Escape to return, Tab to list, Tab to tree ──
    console.log("\n>>> [4] Pressing Escape → back");
    await sendKey("\x1b");
    await sleep(1000);

    console.log("\n>>> [5] Pressing Tab → back to list");
    await sendKey("\t");
    await sleep(2000);

    // ── PHASE 5: Try filtering by codex ──
    console.log("\n>>> [6] Pressing a to filter by agent...");
    await sendKey("a");
    await sleep(2000);

    const bufAfterA = frameBuffer.slice(frameBuffer.length - 2000);
    const linesA = stripAnsi(bufAfterA);
    console.log(`\n=== PHASE 6: AFTER a (agent filter) ===`);
    linesA.forEach((l, i) => console.log(`${i + 1}| ${l}`));
  }

  // ── PHASE 7: Press q to exit ──
  console.log("\n>>> [7] Pressing q to exit");
  await sendKey("q");
  await sleep(1000);

  // Summary of full buffer
  console.log(`\nTotal buffer: ${frameBuffer.length} chars, ${bootFrames} frames`);

  proc.kill();
  done = true;
  console.log("\nDone.");
}

main().catch(e => { console.error(e); proc.kill(); });
