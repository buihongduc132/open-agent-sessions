import { spawn } from "child_process";
import { join } from "path";

/**
 * Run the OAS CLI with given arguments and capture output.
 * Uses a 4000ms default timeout (configurable).
 */
export async function runCLI(
  args: string[],
  timeoutMs: number = 4000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const cliPath = join(process.cwd(), "bin", "oas");
    const proc = spawn("bun", [cliPath, ...args], {
      cwd: process.cwd(),
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        resolve({ exitCode: 1, stdout, stderr: stderr + "\n[timeout]" });
      }
    }, timeoutMs);

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code: number | null) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout, stderr });
      }
    });
    proc.on("error", (e: Error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ exitCode: 1, stdout, stderr: e.message });
      }
    });
  });
}
