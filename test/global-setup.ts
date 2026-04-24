import { afterAll } from "bun:test";
import { execSync } from "child_process";

afterAll(() => {
  const cwd = process.cwd();
  console.log(`Global cleanup: killing any leftover oas tui processes started from ${cwd}...`);
  try {
    // Only kill processes owned by the current user that were started from the current directory
    const command = `pgrep -u $(whoami) -f 'oas tui' | while read pid; do if [ "$(readlink -f /proc/$pid/cwd 2>/dev/null)" = "${cwd}" ]; then kill -9 $pid; fi; done`;
    execSync(command, { shell: "/bin/bash" });
  } catch (e) {
    // Ignore errors
  }
});
