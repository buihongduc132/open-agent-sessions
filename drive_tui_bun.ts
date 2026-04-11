// drive_tui_bun.ts — use Bun's native PTY support
import type { Subprocess } from "bun";

const ROWS = 40;
const COLS = 160;

console.log("Starting oas tui via Bun PTY...");

const proc = Bun.spawn(["oas", "tui"], {
  cwd: "/home/bhd/Documents/Projects/bhd/open-agent-sessions",
  env: { ...process.env, TERM: "xterm-256color" },
  pty: { rows: ROWS, cols: COLS },
});

console.log("Process spawned, type:", typeof proc);
console.log("proc keys:", Object.keys(proc as any));

// Collect chunks via readable stream
const chunks: Buffer[] = [];

// Try different subscription methods
async function collect() {
  try {
    if (proc.stdout) {
      console.log("stdout type:", typeof proc.stdout);
      console.log("stdout is a ReadableStream?:", (proc.stdout as any).constructor?.name);

      // Bun uses ReadableStream with getReader
      const reader = (proc.stdout as any).getReader();
      if (reader) {
        console.log("Using getReader() for stdout");
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value));
          console.log("stdout chunk:", value?.length ?? 0, "bytes");
        }
      }
    }
  } catch (e) {
    console.error("Collection error:", e);
  }
}

collect();

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("Waiting 8s for initial render...");
  await sleep(8000);
  console.log(`Collected ${chunks.length} chunks, ${chunks.reduce((a, b) => a + b.length, 0)} total bytes`);

  const raw = Buffer.concat(chunks);
  const text = raw.toString("utf8").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const lines = text.split("\n").filter((l) => l.trim());
  console.log(`\n=== INITIAL STATE: ${raw.length}B, ${lines.length} non-empty lines ===`);
  for (const line of lines.slice(0, 40)) {
    console.log(" ", line.slice(0, COLS));
  }

  console.log("\nSending j...");
  if (proc.stdin) {
    proc.stdin.write("j");
  }
  await sleep(1000);

  console.log("Sending Enter...");
  if (proc.stdin) {
    proc.stdin.write("\n");
  }
  await sleep(2000);

  const raw2 = Buffer.concat(chunks);
  const text2 = raw2.toString("utf8").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const lines2 = text2.split("\n").filter((l) => l.trim());
  console.log(`\n=== AFTER ENTER: ${raw2.length}B, ${lines2.length} non-empty lines ===`);
  for (const line of lines2.slice(0, 40)) {
    console.log(" ", line.slice(0, COLS));
  }

  proc.kill();
  await proc.exited;
  console.log("Done.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  proc.kill();
  process.exit(1);
});
