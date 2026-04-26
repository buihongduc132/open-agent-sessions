import { afterAll, beforeAll } from "bun:test";
import { execSync, spawn } from "child_process";
import { join } from "path";
import { writeFileSync, chmodSync, unlinkSync } from "fs";

const cwd = process.cwd();
const guardianScriptPath = join(cwd, `.oas-guardian-${Date.now()}.sh`);

// This script will run in the background, watch the parent PID, and kill children when parent dies.
const guardianScript = `#!/bin/bash
PARENT_PID=$1
CWD=$2

# Function to kill oas tui processes in the specific CWD
cleanup() {
  pgrep -u $(whoami) -f 'oas tui' | while read pid; do
    if [ -d /proc/$pid ]; then
      PROC_CWD=$(readlink -f /proc/$pid/cwd 2>/dev/null)
      if [ "$PROC_CWD" = "$CWD" ]; then
        kill -9 $pid 2>/dev/null
      fi
    fi
  done
}

# Watch parent PID
while kill -0 $PARENT_PID 2>/dev/null; do
  sleep 1
done

# Parent is dead, cleanup
cleanup
rm -f $0
`;

beforeAll(() => {
  // Start the guardian process
  writeFileSync(guardianScriptPath, guardianScript);
  chmodSync(guardianScriptPath, 0o755);
  
  const guardian = spawn(guardianScriptPath, [process.pid.toString(), cwd], {
    detached: true,
    stdio: 'ignore'
  });
  guardian.unref();
});

afterAll(() => {
  // Regular cleanup for graceful exit
  try {
    const command = `pgrep -u $(whoami) -f 'oas tui' | while read pid; do if [ -d /proc/$pid ]; then if [ "$(readlink -f /proc/$pid/cwd 2>/dev/null)" = "${cwd}" ]; then kill -9 $pid 2>/dev/null; fi; fi; done`;
    execSync(command, { shell: "/bin/bash" });
  } catch (e) {}
  
  try { unlinkSync(guardianScriptPath); } catch (e) {}
});
