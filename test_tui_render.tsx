#!/usr/bin/env bun
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react/renderer";
import { TuiApp } from "./src/tui/App.tsx";
import { Config } from "./src/config/types.ts";

const config: Config = {
  agents: [
    { agent: "opencode", alias: "default", enabled: true, dbPath: "" },
  ],
};

function renderFrame(frame: string, label: string) {
  const simplified = frame
    .replace(/\x1b\[[0-9;]*m/g, (m) => `[ANSI:${m}]`)
    .replace(/\x1b\[[0-9;]*H/g, "[HOME]")
    .replace(/\x1b\[[0-9;]*J/g, "[CLEAR]")
    .replace(/\x1b\[[0-9;]*r/g, "[SCROLL]")
    .replace(/\x1b\?1049[hl]/g, "[ALTSCREEN]")
    .replace(/./g, (c) => {
      const cp = c.codePointAt(0)!;
      if (cp >= 0x2500 && cp <= 0x257F) return c; // box drawing
      if (cp >= 0x2580 && cp <= 0x259F) return c; // block
      if (cp >= 0x2800 && cp <= 0x28FF) return c; // braille
      if (cp >= 0x20 && cp <= 0x7E) return c;     // printable ASCII
      if (c === "\n" || c === "\t") return c;
      return "";
    });
  console.log(`\n=== ${label} (${frame.length} raw chars) ===`);
  const lines = simplified.split("\n").filter(l => l.length > 0);
  for (const line of lines.slice(0, 40)) {
    console.log(line.substring(0, 120));
  }
}

async function main() {
  console.log("=== Creating test renderer ===");
  const { renderer, mockInput, captureCharFrame } = await createTestRenderer({
    width: 120,
    height: 40,
    testing: true,
  });

  renderFrame(captureCharFrame(), "Initial frame (empty renderer)");

  console.log("\n=== Rendering TuiApp with empty session list ===");
  const root = createRoot(renderer);

  await new Promise<void>((resolve) => {
    flushSync(() => {
      root.render(
        <TuiApp
          config={config}
          list={async () => ({ sessions: [], errors: [] })}
          getSession={async () => null}
          cloneSession={async () => ({ success: false, error: "" })}
        />
      );
    });
    resolve();
  });

  renderFrame(captureCharFrame(), "After TuiApp render (empty list)");

  console.log("\n=== Pressing Down key ===");
  mockInput.pressKey("ARROW_DOWN");
  renderFrame(captureCharFrame(), "After ARROW_DOWN");

  console.log("\n=== Pressing 'q' to quit ===");
  mockInput.pressKey("q");

  console.log("\nDone — renderer exited cleanly.");
  renderer.destroy();
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
