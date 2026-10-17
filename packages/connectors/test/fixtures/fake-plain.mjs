#!/usr/bin/env node
// Fausse CLI texte : écrit deux lignes puis sort avec le code demandé.
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log(process.env.FAKE_VERSION ?? "hermes 0.18.0");
  process.exit(Number(process.env.FAKE_VERSION_EXIT ?? 0));
}
if (process.env.FAKE_HANG === "1") setInterval(() => {}, 1000);
else {
  console.log("ligne 1");
  console.error("avertissement");
  console.log("ligne 2");
  // Comme `hermes chat -Q` : identifiant de session sur stderr à la fin.
  if (process.env.FAKE_SESSION) console.error(`\nsession_id: ${process.env.FAKE_SESSION}`);
  process.exit(Number(process.env.FAKE_EXIT ?? 0));
}
