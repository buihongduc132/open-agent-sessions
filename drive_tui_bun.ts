// drive_tui_bun.ts — capture ALL PTY frames incrementally, then interact
import { writeFileSync } from "fs";

const ROWS = 40, COLS = 160;

const proc = Bun.spawn(["oas", "tui"], {
  cwd: "/home/bhd/Documents/Projects/bhd/open-agent-sessions",
  env: { ...process.env, TERM: "xterm-256color" },
  pty: { rows: ROWS, cols: COLS },
});

const allFrames: { ts: number; bytes: number[] }[] = [];
let currentBytes: number[] = [];
let lastFlush = Date.now();
let done = false;

async function reader() {
  if (!proc.stdout) return;
  const r = (proc.stdout as any).getReader();
  let flushTimer: any;
  const flush = () => {
    if (currentBytes.length > 0) {
      allFrames.push({ ts: Date.now(), bytes: [...currentBytes] });
      currentBytes = [];
      lastFlush = Date.now();
    }
    flushTimer = setTimeout(flush, 500);
  };
  flush();
  try {
    while (true) {
      const { done: d, value } = await r.read();
      if (d) break;
      for (const b of value) currentBytes.push(b);
    }
  } finally {
    clearTimeout(flushTimer);
    done = true;
  }
}

reader();

// ANSI screen-state parser
function parseScreen(bytes: number[]): { rows: string[]; keybar: string } {
  const screen: string[][] = Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => " ")
  );
  let row = 0, col = 0;
  let pos = 0;

  while (pos < bytes.length) {
    const b = bytes[pos];

    if (b === 0x1b && bytes[pos + 1] === 0x5d) { // OSC
      pos += 2;
      while (pos < bytes.length && bytes[pos] !== 0x07 && bytes[pos] !== 0x9c) {
        if (bytes[pos] === 0x1b && bytes[pos + 1] === 0x5c) { pos += 2; break; }
        pos++;
      }
      if (pos < bytes.length) pos++;
      continue;
    }

    if (b === 0x1b && bytes[pos + 1] === 0x5b) { // CSI
      const startCSI = pos;
      pos += 2; let p = pos;
      while (p < bytes.length && bytes[p] >= 0x30 && bytes[p] <= 0x3f) p++;
      while (p < bytes.length && bytes[p] >= 0x40 && bytes[p] <= 0x7e) {
        const final = bytes[p];
        const paramStr = String.fromCharCode(...bytes.slice(startCSI + 2, p)).replace(/[^0-9;]/g, "");
        const parts = paramStr.split(";").filter(s => s).map(Number);
        if (final === 0x48) { row = (parts[0] || 1) - 1; col = (parts[1] || 1) - 1; } // CUP
        else if (final === 0x41) row = Math.max(0, row - (parts[0] || 1)); // CUU
        else if (final === 0x42) row = Math.min(ROWS - 1, row + (parts[0] || 1)); // CUD
        else if (final === 0x43) col = Math.min(COLS - 1, col + (parts[0] || 1)); // CUF
        else if (final === 0x44) col = Math.max(0, col - (parts[0] || 1)); // CUB
        else if (final === 0x4a) for (let c = col; c < COLS; c++) screen[row][c] = " "; // EL
        row = Math.max(0, Math.min(ROWS - 1, row));
        col = Math.max(0, Math.min(COLS - 1, col));
        p++; pos = p; break;
      }
      if (p >= bytes.length || bytes[p] < 0x40 || bytes[p] > 0x7e) pos = p;
      continue;
    }

    if (b === 0x1b) { pos++; continue; }
    if (b === 0x0d) { col = 0; pos++; continue; }
    if (b === 0x0a) { row = Math.min(ROWS - 1, row + 1); pos++; continue; }
    if (b === 0x08) { col = Math.max(0, col - 1); pos++; continue; }

    if (b >= 0x20 && b <= 0x7e) {
      screen[row][col] = String.fromCharCode(b);
      col = Math.min(COLS - 1, col + 1); pos++; continue;
    }

    if (b >= 0xc0) {
      const rem = bytes.length - pos;
      let char = b, len = 1;
      if (b < 0xe0 && rem >= 2) { char = ((b & 0x1f) << 6) | (bytes[pos + 1] & 0x3f); len = 2; }
      else if (b < 0xf0 && rem >= 3) { char = ((b & 0x0f) << 12) | ((bytes[pos + 1] & 0x3f) << 6) | (bytes[pos + 2] & 0x3f); len = 3; }
      else if (rem >= 4) { char = ((b & 0x07) << 18) | ((bytes[pos + 1] & 0x3f) << 12) | ((bytes[pos + 2] & 0x3f) << 6) | (bytes[pos + 3] & 0x3f); len = 4; }
      screen[row][col] = String.fromCharCode(char);
      col = Math.min(COLS - 1, col + 1); pos += len; continue;
    }

    pos++;
  }

  const rows = screen.map(r => r.join("").trimEnd()).filter(r => r.length > 0);
  const keybar = rows.length > 0 ? rows[rows.length - 1] : "";
  return { rows, keybar };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("Waiting for TUI to fully load (up to 30s)...");

  // Wait for enough frames to accumulate (indication of full render)
  // Each full screen render is ~6000 bytes; waiting for 3+ frames means data is loaded
  let waited = 0;
  while (waited < 30000) {
    await sleep(1000);
    waited += 1000;
    const totalBytes = allFrames.reduce((a, f) => a + f.bytes.length, 0);
    const frameCount = allFrames.length;
    console.log(`  t=${waited}s: ${frameCount} frames, ${totalBytes} bytes`);
    // After ~10s we should have multiple frames if sessions are loading
    if (frameCount >= 3 && waited > 8000) break;
  }

  // Dump accumulated frames to file for analysis
  const totalBytes = allFrames.reduce((a, f) => a + f.bytes.length, 0);
  console.log(`\nTotal: ${allFrames.length} frames, ${totalBytes} bytes`);

  // Show final frame before interaction
  if (allFrames.length > 0) {
    const last = allFrames[allFrames.length - 1];
    const { rows, keybar } = parseScreen(last.bytes);
    console.log(`\n=== FRAME ${allFrames.length} (t=${last.ts - allFrames[0].ts}ms after start) ===`);
    console.log(`KEYBAR: ${keybar}`);
    rows.slice(0, 5).forEach((r, i) => console.log(`${i + 1}| ${r}`));
    console.log(`  ... (${rows.length} rows total)`);
  }

  // === TREE VIEW: interact now ===
  console.log("\n>>> [A] Pressing Enter on selected session (open detail from tree)...");
  try { (proc.stdin as any)?.write?.("\n"); } catch (_) {}
  await sleep(3000);

  const frameA = allFrames[allFrames.length - 1];
  const { rows: rowsA, keybar: kbA } = parseScreen(frameA.bytes);
  console.log(`\n=== AFTER Enter (tree→detail): KEYBAR="${kbA}" ===`);
  rowsA.forEach((r, i) => console.log(`${String(i + 1).padStart(2)}| ${r}`));

  // Press Escape to return
  console.log("\n>>> [B] Pressing Escape (return from detail)...");
  try { (proc.stdin as any)?.write?.("\x1b"); } catch (_) {}
  await sleep(2000);

  // Press Tab to switch to timeline
  console.log("\n>>> [C] Pressing Tab (switch to timeline)...");
  try { (proc.stdin as any)?.write?.("\t"); } catch (_) {}
  await sleep(2000);

  const frameC = allFrames[allFrames.length - 1];
  const { rows: rowsC, keybar: kbC } = parseScreen(frameC.bytes);
  console.log(`\n=== AFTER Tab (timeline view): KEYBAR="${kbC}" ===`);
  rowsC.forEach((r, i) => console.log(`${String(i + 1).padStart(2)}| ${r}`));

  // Press Enter on a session in timeline
  console.log("\n>>> [D] Pressing Enter (open detail from timeline)...");
  try { (proc.stdin as any)?.write?.("\n"); } catch (_) {}
  await sleep(2000);

  const frameD = allFrames[allFrames.length - 1];
  const { rows: rowsD, keybar: kbD } = parseScreen(frameD.bytes);
  console.log(`\n=== AFTER Enter (timeline→detail): KEYBAR="${kbD}" ===`);
  rowsD.forEach((r, i) => console.log(`${String(i + 1).padStart(2)}| ${r}`));

  // Return from timeline detail
  console.log("\n>>> [E] Pressing Escape (return from timeline detail)...");
  try { (proc.stdin as any)?.write?.("\x1b"); } catch (_) {}
  await sleep(1000);

  // Exit
  console.log("\n>>> [F] Pressing q (exit)...");
  try { (proc.stdin as any)?.write?.("q"); } catch (_) {}
  await sleep(500);

  // Write all raw bytes to file
  const allBytes = allFrames.flatMap(f => f.bytes);
  writeFileSync("/tmp/oas_tui_raw.bin", Buffer.from(allBytes));
  console.log(`\nWrote ${allBytes.length} raw bytes to /tmp/oas_tui_raw.bin`);

  proc.kill();
  await proc.exited.catch(() => {});
  console.log("\nDone.");
}

main().catch(e => { console.error(e); proc.kill(); });
