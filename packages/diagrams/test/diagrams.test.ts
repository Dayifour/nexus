import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ScanRefusedError, matchWorkspacePattern, parseCompose, scanProject, type ProjectScan } from "../src/index.ts";

type T = { after: (fn: () => unknown) => void };

function tmp(t: T): string {
  const dir = mkdtempSync(join(tmpdir(), "nexus-diagrams-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

const idOf = (scan: ProjectScan, name: string) => {
  const c = scan.components.find((x) => x.name === name);
  assert.ok(c, `composant ${name} attendu`);
  return c.id;
};

test("monorepo npm : 2 workspaces dépendants, frameworks et dépendances", (t) => {
  const root = tmp(t);
  write(root, "package.json", JSON.stringify({ name: "mono", workspaces: ["packages/*", "apps/*"] }));
  write(
    root,
    "apps/web/package.json",
    JSON.stringify({ name: "@acme/web", dependencies: { next: "15", react: "19", "@acme/db": "*" } }),
  );
  write(
    root,
    "packages/db/package.json",
    JSON.stringify({ name: "@acme/db", dependencies: { "@prisma/client": "7" }, devDependencies: { prisma: "7" } }),
  );
  write(root, "node_modules/evil/package.json", JSON.stringify({ name: "evil" }));
  write(root, "vercel.json", JSON.stringify({ framework: "nextjs" }));

  const scan = scanProject({ root, allowedRoots: [root] });
  const web = scan.components.find((c) => c.name === "@acme/web");
  const db = scan.components.find((c) => c.name === "@acme/db");
  assert.ok(web && db);
  assert.deepEqual(web.frameworks.sort(), ["Next.js", "React"]);
  assert.deepEqual(db.frameworks, ["Prisma"]);
  assert.ok(!scan.components.some((c) => c.name === "evil"), "node_modules ignoré");
  assert.ok(scan.skipped.some((s) => s.path === "node_modules" && s.reason === "ignored-directory"));
  assert.ok(scan.edges.some((e) => e.from === web.id && e.to === db.id && e.kind === "workspace-dependency"));
  const mono = idOf(scan, "mono");
  assert.equal(scan.edges.filter((e) => e.from === mono && e.kind === "workspace-member").length, 2);
});

test("docker-compose à 2 services : services, depends_on et build", (t) => {
  const root = tmp(t);
  write(root, "api/package.json", JSON.stringify({ name: "api", dependencies: { express: "5" } }));
  write(root, "api/Dockerfile", "FROM node:24-alpine\nEXPOSE 3000\n");
  write(
    root,
    "docker-compose.yml",
    [
      "# pile locale",
      "services:",
      "  api:",
      "    build: ./api",
      "    ports:",
      '      - "3000:3000"',
      "    depends_on:",
      "      db:",
      "        condition: service_healthy",
      "  db:",
      "    image: postgres:17",
      "volumes:",
      "  data:",
      "",
    ].join("\n"),
  );
  const scan = scanProject({ root, allowedRoots: [root] });
  const services = scan.components.filter((c) => c.kind === "compose-service");
  assert.deepEqual(services.map((s) => s.name).sort(), ["api", "db"]);
  const api = services.find((s) => s.name === "api");
  const db = services.find((s) => s.name === "db");
  assert.ok(api && db);
  assert.deepEqual(api.details.ports, ["3000:3000"]);
  assert.ok(scan.edges.some((e) => e.from === api.id && e.to === db.id && e.kind === "compose-depends-on"));
  assert.ok(scan.edges.some((e) => e.from === api.id && e.kind === "builds-from"));

  // Formes alternatives de depends_on.
  const alt = parseCompose(
    'services:\n  a:\n    depends_on: [b, "c"]\n  b:\n    depends_on:\n      - c\n  c:\n    image: redis\n',
  );
  assert.deepEqual(
    alt.map((s) => [s.name, s.dependsOn]),
    [
      ["a", ["b", "c"]],
      ["b", ["c"]],
      ["c", []],
    ],
  );
});

test("projet Python : requirements.txt + pyproject.toml fusionnés, frameworks détectés", (t) => {
  const root = tmp(t);
  write(root, "requirements.txt", "# deps\nFastAPI>=0.115\nSQLAlchemy==2.0 ; python_version>'3.9'\n-r dev.txt\n");
  write(
    root,
    "pyproject.toml",
    '[project]\nname = "inventaire"\ndependencies = [\n  "uvicorn>=0.30",\n  "fastapi",\n]\n',
  );
  const scan = scanProject({ root, allowedRoots: [root] });
  const py = scan.components.filter((c) => c.kind === "python-project");
  assert.equal(py.length, 1);
  assert.equal(py[0]?.name, "inventaire");
  assert.deepEqual(py[0]?.frameworks.sort(), ["FastAPI", "SQLAlchemy"]);
  assert.ok(py[0]?.details.dependencies?.includes("uvicorn"));
});

test("noms hostiles : conservés comme données, dépendance interne retrouvée", (t) => {
  const hostile = 'a"]-->B[x';
  const root = tmp(t);
  write(root, "package.json", JSON.stringify({ name: "mono", workspaces: ["pkgs/*"] }));
  write(root, "pkgs/a/package.json", JSON.stringify({ name: hostile, dependencies: { "evil\nflowchart TD": "1" } }));
  write(
    root,
    "pkgs/b/package.json",
    JSON.stringify({ name: "ok\nB-->C;click B call x()", dependencies: { [hostile]: "*" } }),
  );
  write(root, "docker-compose.yml", 'services:\n  "w]-->z":\n    image: "img\\"]"\n');

  const scan = scanProject({ root, allowedRoots: [root] });
  const a = idOf(scan, hostile);
  const b = idOf(scan, "ok\nB-->C;click B call x()");
  assert.ok(/^c\d+$/.test(a) && /^c\d+$/.test(b), "identifiants internes jamais dérivés des noms");
  assert.ok(scan.edges.some((e) => e.from === b && e.to === a && e.kind === "workspace-dependency"));
});

test("symlink sortant non suivi, .env jamais lu, gros fichiers ignorés, liste blanche imposée", (t) => {
  const base = tmp(t);
  const root = join(base, "projet");
  const outside = join(base, "dehors");
  write(outside, "package.json", JSON.stringify({ name: "secret-hors-projet" }));
  write(outside, "inner/package.json", JSON.stringify({ name: "secret-dossier" }));
  write(root, "package.json", JSON.stringify({ name: "app", dependencies: { vite: "8" } }));
  symlinkSync(join(outside, "inner"), join(root, "lien-dossier"));
  mkdirSync(join(root, "sub"));
  symlinkSync(join(outside, "package.json"), join(root, "sub", "package.json"));
  // `.env` illisible : toute tentative d'ouverture échouerait, et son contenu ne doit apparaître nulle part.
  write(root, ".env", "API_KEY=sk-ne-doit-jamais-sortir");
  write(root, ".env.local", "TOKEN=xyz");
  write(root, "config/.env.production/package.json", JSON.stringify({ name: "dans-env" }));
  chmodSync(join(root, ".env"), 0o000);
  write(root, "big/package.json", JSON.stringify({ name: "gros", pad: "x".repeat(1024 * 1024 + 10) }));

  const scan = scanProject({ root, allowedRoots: [base] });
  const names = scan.components.map((c) => c.name);
  assert.deepEqual(names, ["app"]);
  assert.ok(scan.skipped.some((s) => s.path === "lien-dossier" && s.reason === "symlink-outside-root"));
  assert.ok(scan.skipped.some((s) => s.path === "sub/package.json" && s.reason === "symlink-outside-root"));
  assert.ok(scan.skipped.some((s) => s.path === "big/package.json" && s.reason === "too-large"));
  assert.equal(scan.envFilesIgnored, 3);
  assert.ok(!scan.manifestsRead.some((m) => m.includes(".env")));
  const all = JSON.stringify(scan);
  assert.ok(!all.includes("sk-ne-doit") && !all.includes("TOKEN=") && !all.includes("secret-"));

  assert.throws(() => scanProject({ root, allowedRoots: [join(base, "autre")] }), ScanRefusedError);
  assert.throws(() => scanProject({ root: outside, allowedRoots: [root] }), ScanRefusedError);
  // Racine passée par un lien symbolique qui pointe hors liste blanche : refusée après résolution.
  symlinkSync(outside, join(root, "raccourci"));
  assert.throws(() => scanProject({ root: join(root, "raccourci"), allowedRoots: [root] }), ScanRefusedError);
});

test("go.mod et Cargo.toml : frameworks détectés, .env ignoré sans lecture", (t) => {
  const root = tmp(t);
  write(root, "go.mod", "module example.com/svc\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n)\n");
  write(root, "Cargo.toml", '[package]\nname = "outil"\n\n[dependencies]\naxum = "0.8"\n');
  write(root, ".env", "X=1");
  const scan = scanProject({ root, allowedRoots: [root] });
  assert.deepEqual(
    scan.components
      .map((c) => c.frameworks)
      .flat()
      .sort(),
    ["Axum", "Gin"],
  );
  assert.equal(scan.envFilesIgnored, 1);
  assert.deepEqual(scanProject({ root: tmp(t), allowedRoots: [tmpdir()] }).components, []);
});

test("motifs de workspaces", () => {
  assert.ok(matchWorkspacePattern("packages/*", "packages/db"));
  assert.ok(!matchWorkspacePattern("packages/*", "packages/db/sub"));
  assert.ok(matchWorkspacePattern("./libs/**", "libs/a/b"));
  assert.ok(matchWorkspacePattern("tools/cli", "tools/cli"));
  assert.ok(!matchWorkspacePattern("apps/*", "packages/x"));
});
