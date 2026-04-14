// drive_tui_verify2.ts — captures raw PTY output, strips ANSI, verifies views
// Uses Node.js child_process PTY with proper ANSI stripping
const { spawn } = require("child_process");
const fs = require("fs");

const ROWS = 40, COLS = 160;
const rawAll = [];

// ANSI stripper that handles SGR sequences and OSC
function stripAnsi(buf) {
  const str = buf.toString("utf8");
  // Remove all ANSI escape sequences
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")      // SGR + cursor
    .replace(/\x1b\][^\x07]*\x07/g, "")          // OSC
    .replace(/\x1b\[[?0-9;]*[a-zA-Z]/g, "")      // more CSI
    .replace(/\x1b\][0-9];[^\x07]*\x07/g, "")    // OSC 0;title
    .replace(/\x1b\[>[0-9;]*[a-zA-Z]/g, "")     // DECSET
    .replace(/\x1b\[=[0-9;]*[a-zA-Z]/g, "")     // DECSET alt
    .replace(/\x1b\(B/g, "")                    // charset
    .replace(/\x1b>/g, "")                     // normal keypad
    .replace(/\x1b=/g, "")                     // alternate keypad
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "") // control chars
    .replace(/\x9b/g, "")                      // CSI (single byte)
    .replace(/\x8d/g, "")                      // RI
    .replace(/\x8e/g, "")                      // SS2
    .replace(/\x8f/g, "")                      // SS3
    .replace(/\xc2/g, "")                      // leftover UTF8 start
    .trim();
}

function extractVisibleLines(buf) {
  const stripped = stripAnsi(buf);
  return stripped
    .split("\n")
    .map(l => l.trimEnd())
    .filter(l => /[a-zA-Z0-9]/.test(l))  // must have at least one alphanumeric
    .filter(l => l.length >= 3);
}

// Simple SGR parser to get fg color text
function getColorAnsiToText(buf) {
  const str = buf.toString("utf8");
  // Parse the raw output line by line, ignoring escape sequences
  const lines = [];
  let current = "";
  let pos = 0;

  while (pos < str.length) {
    if (str.charCodeAt(pos) === 0x1b && str.charCodeAt(pos + 1) === 0x5b) {
      // CSI sequence
      let end = pos + 2;
      while (end < str.length && end < pos + 20) {
        const c = str.charCodeAt(end);
        if (c >= 0x40 && c <= 0x7e) {
          end++;
          break;
        }
        end++;
      }
      const seq = str.slice(pos, end);
      // SGR (Select Graphic Rendition) — color codes
      if (seq.endsWith("m")) {
        // parse params
        const params = seq.slice(2, -1).split(";").filter(s => s).map(Number);
        current += `[${params.join(";")}m`;
      }
      pos = end;
    } else if (str.charCodeAt(pos) >= 0x20 || str.charCodeAt(pos) === 0x09) {
      current += str[pos];
      pos++;
    } else if (str.charCodeAt(pos) === 0x0d || str.charCodeAt(pos) === 0x0a) {
      if (current.trim().length > 0) lines.push(current.trimEnd());
      current = "";
      pos++;
    } else {
      pos++;
    }
  }
  if (current.trim().length > 0) lines.push(current.trimEnd());
  return lines;
}

const proc = spawn("oas", ["tui"], {
  cwd: "/home/bhd/Documents/Projects/bhd/open-agent-sessions",
  env: { ...process.env, TERM: "xterm-256color" },
  rows: ROWS,
  cols: COLS,
  stdio: ["pipe", "pipe", "pipe"],
});

let raw = Buffer.alloc(0);

proc.stdout.on("data", (chunk) => {
  raw = Buffer.concat([raw, chunk]);
});

proc.stderr.on("data", (chunk) => {
  const txt = chunk.toString("utf8");
  if (txt.includes("DEBUG")) process.stderr.write(txt);
});

function sendKey(key) {
  return new Promise(resolve => proc.stdin.write(key, resolve));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("Starting oas tui... (waiting for sessions)\n");

  let waited = 0;
  let lastRawLen = 0;
  const rawStart = raw.length;

  // Wait for output to stabilize (delta < 100 bytes for 3 consecutive checks)
  let stableCount = 0;
  while (waited < 120000) {
    await sleep(3000);
    waited += 3000;
    const delta = raw.length - lastRawLen;
    lastRawLen = raw.length;
    const stable = delta < 100;
    if (stable) stableCount++; else stableCount = 0;
    console.log(`  t=${waited/1000}s: raw=${raw.length}B, delta=${delta}B, stable=${stableCount}`);
    if (stableCount >= 3 && waited > 15000) break;
  }

  console.log(`\nCaptured ${raw.length} raw bytes after ${waited/1000}s`);

  // ── Show full screen ──
  const lines = getColorAnsiToText(raw);
  console.log(`\n=== CURRENT SCREEN (${lines.length} visible lines) ===`);
  lines.forEach((l, i) => console.log(`${String(i+1).padStart(2)}| ${l}`));

  // ── KEYBAR FOOTER ──
  const footer = lines[lines.length - 1] || "";
  console.log(`\nFOOTER: "${footer}"`);

  // ── CONTENT CHECK ──
  const fullText = lines.join(" ");
  const hasLoading = fullText.toLowerCase().includes("loading");
  const hasCodex = fullText.toLowerCase().includes("codex");
  const hasOpencode = fullText.toLowerCase().includes("opencode");
  const hasForkTree = fullText.toLowerCase().includes("fork tree") || fullText.toLowerCase().includes("tree");
  const hasSessions = fullText.toLowerCase().includes("sessions");

  console.log(`\n--- CONTENT CHECK ---`);
  console.log(`  "loading":    ${hasLoading}`);
  console.log(`  "codex":      ${hasCodex}`);
  console.log(`  "opencode":   ${hasOpencode}`);
  console.log(`  "tree":       ${hasForkTree}`);
  console.log(`  "sessions":  ${hasSessions}`);

  // ── PHASE 1: Press Tab → tree view ──
  console.log(`\n>>> [1] Sending Tab → switch to tree view`);
  await sendKey("\t");
  await sleep(3000);

  const rawAfterTab = raw.slice(raw.length - 10000);
  const linesTab = getColorAnsiToText(rawAfterTab);
  const footerTab = linesTab[linesTab.length - 1] || "";
  console.log(`\n=== AFTER Tab (tree): FOOTER="${footerTab}" ===`);
  linesTab.slice(-20).forEach((l, i) => console.log(`${String(i+1).padStart(2)}| ${l}`));

  const textTab = linesTab.join(" ");
  const treeHasCodex = textTab.toLowerCase().includes("codex");
  const treeHasOpencode = textTab.toLowerCase().includes("opencode");
  const isTreeView = footerTab.toLowerCase().includes("tree") || footerTab.toLowerCase().includes("fork");
  console.log(`\n>>> TREE VIEW CHECK:`);
  console.log(`  view name = "tree": ${isTreeView}`);
  console.log(`  codex present:      ${treeHasCodex}`);
  console.log(`  opencode present:   ${treeHasOpencode}`);

  // ── PHASE 2: Press Enter → open detail ──
  if (treeHasCodex || treeHasOpencode) {
    console.log(`\n>>> [2] Sending Enter → open session detail`);
    await sendKey("\n");
    await sleep(3000);

    const rawAfterEnter = raw.slice(raw.length - 10000);
    const linesEnter = getColorAnsiToText(rawAfterEnter);
    const footerEnter = linesEnter[linesEnter.length - 1] || "";
    console.log(`\n=== AFTER Enter: FOOTER="${footerEnter}" ===`);
    linesEnter.slice(-20).forEach((l, i) => console.log(`${String(i+1).padStart(2)}| ${l}`));

    const textEnter = linesEnter.join(" ");
    const hasTimeline = textEnter.toLowerCase().includes("timeline");
    const hasDetail = textEnter.toLowerCase().includes("detail") || textEnter.toLowerCase().includes("session");
    console.log(`\n>>> DETAIL CHECK:`);
    console.log(`  "timeline": ${hasTimeline}`);
    console.log(`  "detail":   ${hasDetail}`);

    // ── PHASE 3: Press t → timeline view ──
    console.log(`\n>>> [3] Sending t → switch to timeline`);
    await sendKey("t");
    await sleep(3000);

    const rawAfterT = raw.slice(raw.length - 10000);
    const linesT = getColorAnsiToText(rawAfterT);
    const footerT = linesT[linesT.length - 1] || "";
    console.log(`\n=== AFTER t (timeline): FOOTER="${footerT}" ===`);
    linesT.slice(-20).forEach((l, i) => console.log(`${String(i+1).padStart(2)}| ${l}`));

    const textT = linesT.join(" ");
    const timelineHasCodex = textT.toLowerCase().includes("codex");
    const timelineHasOpencode = textT.toLowerCase().includes("opencode");
    const isTimelineView = footerT.toLowerCase().includes("timeline");
    console.log(`\n>>> TIMELINE VIEW CHECK:`);
    console.log(`  view name = "timeline": ${isTimelineView}`);
    console.log(`  codex present:          ${timelineHasCodex}`);
    console.log(`  opencode present:      ${timelineHasOpencode}`);

    // ── PHASE 4: Press Esc → return, Tab → back to list ──
    console.log(`\n>>> [4] Sending Escape → return`);
    await sendKey("\x1b");
    await sleep(1000);

    console.log(`\n>>> [5] Sending Tab → back to list`);
    await sendKey("\t");
    await sleep(2000);
  }

  // ── PHASE 6: Exit ──
  console.log(`\n>>> [6] Sending q → exit`);
  await sendKey("q");
  await sleep(1000);

  // Write full raw capture for debugging
  fs.writeFileSync("/tmp/oas_tui_capture_full.bin", raw);
  console.log(`\nWrote ${raw.length} raw bytes to /tmp/oas_tui_capture_full.bin`);
  console.log("Done.");

  proc.kill();
  process.exit(0);
}

main().catch(e => { console.error(e); proc.kill(); process.exit(1); });
