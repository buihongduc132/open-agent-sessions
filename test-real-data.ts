import { createAntigravityAdapter } from "./src/adapters/antigravity";
import { createGeminiAdapter } from "./src/adapters/gemini";
import { OtherAgentEntry } from "./src/config/types";
import { homedir } from "node:os";
import { join } from "node:path";

async function main() {
  console.log("Testing Antigravity Adapter with real data...");
  const agEntry: OtherAgentEntry = {
    agent: "antigravity",
    alias: "real-ag",
    enabled: true,
    path: join(homedir(), ".gemini", "antigravity"),
  };
  
  try {
    const agAdapter = createAntigravityAdapter(agEntry);
    const agSessions = agAdapter.listSessions().filter(s => s.message_count > 0);
    console.log(`Found ${agSessions.length} Antigravity sessions with messages.`);
    if (agSessions.length > 0) {
      console.log("First session with messages summary:");
      console.log(JSON.stringify(agSessions[0], null, 2));
      
      const detail = await agAdapter.getSessionDetail!(agSessions[0].id, {});
      console.log(`Found ${detail.messages?.length} messages in first session.`);
      if (detail.messages && detail.messages.length > 0) {
        console.log("First message preview:");
        console.log(detail.messages[0].parts[0]);
      }
    }
  } catch (e) {
    console.error("Antigravity test failed:", e);
  }

  console.log("\nTesting Gemini Adapter with real data...");
  const geminiEntry: OtherAgentEntry = {
    agent: "gemini",
    alias: "real-gemini",
    enabled: true,
    path: join(homedir(), ".gemini", "tmp"),
  };

  try {
    const geminiAdapter = createGeminiAdapter(geminiEntry);
    const geminiSessions = geminiAdapter.listSessions();
    console.log(`Found ${geminiSessions.length} Gemini sessions.`);
    if (geminiSessions.length > 0) {
      console.log("First session summary:");
      console.log(JSON.stringify(geminiSessions[0], null, 2));
    }
  } catch (e) {
    console.error("Gemini test failed:", e);
  }
}

main();
