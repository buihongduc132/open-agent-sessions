import { createCliRenderer } from "@opentui/core";
console.error("TEST: before createCliRenderer");
const renderer = await createCliRenderer({ exitOnCtrlC: false });
console.error("TEST: after createCliRenderer, renderer created");
renderer.destroy();
console.error("TEST: done");
