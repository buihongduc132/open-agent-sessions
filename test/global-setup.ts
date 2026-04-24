import { afterAll } from "bun:test";
import { execSync } from "child_process";

afterAll(() => {
  console.log("Global cleanup: killing any leftover oas tui processes...");
  try {
    // SIGKILL is more reliable to ensure they are gone
    execSync("pkill -9 -f 'oas tui' || true");
  } catch (e) {
    // Ignore errors if pkill fails (e.g. no processes found)
  }
});
