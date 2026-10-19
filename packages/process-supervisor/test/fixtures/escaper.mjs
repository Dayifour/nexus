// Fixture adversariale : lance un descendant détaché (`detached` = setsid(), nouvelle session, donc hors du groupe
// de processus du parent), qui écrit "<pid>:<compteur>" dans un fichier toutes les 50 ms.
// La preuve de mort repose sur l'arrêt du battement, pas sur le PID (dans un PID namespace, le PID
// écrit n'est pas un PID hôte). Le PID n'est utilisé que pour nettoyer la démonstration d'évasion.
// Garde-fou : le descendant se termine seul après DEADMAN_MS, pour qu'une évasion démontrée
// ne laisse jamais de processus durable sur la machine.
// Usage : node escaper.mjs <heartbeatFile> [--ignore-sigterm] [--exit-soon]
import { spawn } from "node:child_process";

const [heartbeatFile, ...flags] = process.argv.slice(2);
const DEADMAN_MS = 8000;
if (flags.includes("--ignore-sigterm")) process.on("SIGTERM", () => {});
const beat = `process.on('SIGTERM',()=>{});const fs=require('fs');let n=0;
setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeatFile)},process.pid+':'+(++n)),50);
setTimeout(()=>process.exit(0),${DEADMAN_MS});`;
spawn(process.execPath, ["-e", beat], { stdio: "ignore", detached: true }).unref();
// --exit-soon : le parent se termine normalement en laissant le descendant « démonisé ».
if (flags.includes("--exit-soon")) setTimeout(() => process.exit(0), 300);
else setInterval(() => {}, 1000);
