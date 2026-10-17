// Fixture : processus « Nexus » qui supervise l'évadeur (escaper.mjs) puis attend d'être tué brutalement.
// Usage : node supervisor-parent.ts <escaper.mjs> <heartbeatFile>
import { runProcess } from "../../src/index.ts";

const [escaper, heartbeat] = process.argv.slice(2);
void runProcess({ file: process.execPath, args: [escaper!, heartbeat!], cwd: "/", env: {}, timeoutMs: 60_000 });
setInterval(() => {}, 1000);
