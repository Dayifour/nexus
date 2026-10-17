// Fonctions pures : validation, scanner de secrets, plans et empreintes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeRefName,
  canonicalJson,
  isSafeRefName,
  maskSecretsInText,
  mergePlanFingerprint,
  parseNameStatusZ,
  parsePorcelainZ,
  planPush,
  scanDiffForSecrets,
  unquoteDiffPath,
  type PushPlanInput,
} from "../src/index.ts";

test("validation des réfs : liste blanche", () => {
  for (const ok of ["main", "feature/login", "nexus/task-T-1", "v1.2.3", "HEAD", "release_2026", "a".repeat(40)]) {
    assert.equal(assertSafeRefName(ok), ok);
  }
  for (const bad of [
    "--upload-pack=x",
    "-x",
    "a..b",
    "a b",
    "a\tb",
    "a\u0000b",
    "a\u001bb",
    "@{-1}",
    "x@{u}",
    "/abs",
    "a.lock",
    "a/-b",
    "é",
    "a".repeat(201),
  ]) {
    assert.equal(isSafeRefName(bad), false, JSON.stringify(bad));
  }
});

const SK = "sk-proj-" + "abcdefghijklmnopqrstuvwxyz012345";
const GHP = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789";
const PAT = "github_pat_" + "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz";
const AKIA = "AKIA" + "IOSFODNN7EXAMPLE";
const PEM_BODY = "MIIEowIBAAKCAQEAsecretbodysecretbody";

const DIFF = [
  "diff --git a/src/conf.ts b/src/conf.ts",
  "index 1111111..2222222 100644",
  "--- a/src/conf.ts",
  "+++ b/src/conf.ts",
  "@@ -10,3 +10,5 @@ export const x = 1;",
  " contexte",
  `-const old = "${"sk-" + "oldoldoldoldoldoldold"}";`,
  `+const openai = "${SK}";`,
  `+const gh = "${GHP}", pat = "${PAT}";`,
  " fin",
  "diff --git a/deploy/aws.ini b/deploy/aws.ini",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/deploy/aws.ini",
  "@@ -0,0 +1,2 @@",
  "+[default]",
  `+aws_access_key_id = ${AKIA}`,
  "diff --git a/keys/id_rsa b/keys/id_rsa",
  "new file mode 100600",
  "--- /dev/null",
  "+++ b/keys/id_rsa",
  "@@ -0,0 +1,3 @@",
  "+-----BEGIN RSA PRIVATE KEY-----",
  `+${PEM_BODY}`,
  "+-----END RSA PRIVATE KEY-----",
  "diff --git a/app/.env.local b/app/.env.local",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/app/.env.local",
  "@@ -0,0 +1 @@",
  "+DEBUG=1",
  "diff --git a/.env.example b/.env.example",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/.env.example",
  "@@ -0,0 +1 @@",
  "+DEBUG=",
  "",
].join("\n");

test("scanner de secrets : détection avec fichier/ligne et valeur masquée", () => {
  const { findings, truncated } = scanDiffForSecrets(DIFF);
  assert.equal(truncated, false);
  assert.deepEqual(
    findings.map((f) => [f.rule, f.file, f.line]),
    [
      ["openai_key", "src/conf.ts", 11],
      ["github_pat", "src/conf.ts", 12],
      ["github_token", "src/conf.ts", 12],
      ["aws_access_key", "deploy/aws.ini", 2],
      ["private_key", "keys/id_rsa", 1],
      ["env_file_added", "app/.env.local", 0],
    ],
  );
  const json = JSON.stringify(findings);
  for (const secret of [SK, GHP, PAT, AKIA, PEM_BODY])
    assert.ok(!json.includes(secret), `fuite de ${secret.slice(0, 6)}`);
  assert.ok(!json.includes("oldoldold"), "les lignes supprimées ne sont pas analysées");
  assert.equal(findings.find((f) => f.rule === "github_token")!.masked, "ghp_********");
  assert.equal(findings.find((f) => f.rule === "aws_access_key")!.masked, "AKIA********");
});

test("scanner : borne du nombre de détections, masquage du texte", () => {
  const many = [
    "diff --git a/x b/x",
    "--- a/x",
    "+++ b/x",
    "@@ -1 +1,300 @@",
    ...Array.from({ length: 300 }, () => `+${GHP}`),
  ].join("\n");
  const r = scanDiffForSecrets(many, { maxFindings: 10 });
  assert.equal(r.findings.length, 10);
  assert.equal(r.truncated, true);
  const masked = maskSecretsInText(DIFF);
  for (const secret of [SK, GHP, PAT, AKIA, PEM_BODY]) assert.ok(!masked.includes(secret));
  assert.match(masked, /BEGIN RSA PRIVATE KEY----- \[CORPS MASQUÉ\]/);
});

test("scanner : chemins entre guillemets et renommage vers .env", () => {
  assert.equal(unquoteDiffPath('"b/caf\\303\\251 \\"x\\".txt"'), 'b/café "x".txt');
  const d = ["diff --git a/env.txt b/.env", "similarity index 100%", "rename from env.txt", "rename to .env", ""].join(
    "\n",
  );
  assert.deepEqual(
    scanDiffForSecrets(d).findings.map((f) => [f.rule, f.file]),
    [["env_file_added", ".env"]],
  );
  const d2 = [
    "diff --git a/env.txt b/.env",
    "similarity index 90%",
    "rename from env.txt",
    "rename to .env",
    "--- a/env.txt",
    "+++ b/.env",
    "@@ -1 +1 @@",
    "-A=1",
    "+A=2",
  ].join("\n");
  assert.deepEqual(
    scanDiffForSecrets(d2).findings.map((f) => [f.rule, f.file]),
    [["env_file_added", ".env"]],
  );
});

const PUSH: PushPlanInput = {
  remote: "origin",
  remoteUrl: "https://user:tok3n@github.com/acme/stock.git",
  localBranch: "nexus/task-T-1",
  remoteBranch: "feature/stock",
  commits: [
    { sha: "a".repeat(40), subject: "feat: stock" },
    { sha: "b".repeat(40), subject: "test: stock" },
  ],
  files: [
    { path: "src/b.ts", status: "M" },
    { path: "src/a.ts", status: "A" },
  ],
};

test("planPush : déterministe, résumé lisible, identifiants d'URL retirés", () => {
  const p1 = planPush(PUSH);
  const p2 = planPush(structuredClone(PUSH));
  const p3 = planPush({ ...PUSH, files: [...PUSH.files].reverse() }); // l'ordre des fichiers n'importe pas
  assert.match(p1.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(p1.fingerprint, p2.fingerprint);
  assert.equal(p1.fingerprint, p3.fingerprint);
  assert.equal(p1.action, "git_push");
  assert.equal(p1.plan.force, false);
  assert.equal(p1.blocked, false);
  assert.equal(p1.plan.remoteUrl, "https://github.com/acme/stock.git");
  assert.ok(!JSON.stringify(p1).includes("tok3n"));
  assert.match(p1.summary, /nexus\/task-T-1 -> origin\/feature\/stock/);
  assert.ok(p1.summary.length <= 2000);

  // Toute différence significative change l'empreinte.
  const variants: PushPlanInput[] = [
    { ...PUSH, remoteBranch: "main" },
    { ...PUSH, remote: "upstream" },
    { ...PUSH, commits: [...PUSH.commits].reverse() },
    { ...PUSH, files: [...PUSH.files, { path: ".env", status: "A" }] },
  ];
  for (const v of variants) assert.notEqual(planPush(v).fingerprint, p1.fingerprint);

  const withSecret = planPush({ ...PUSH, secretFindings: scanDiffForSecrets(DIFF).findings });
  assert.equal(withSecret.blocked, true);
  assert.match(withSecret.summary, /SECRETS DÉTECTÉS/);

  assert.throws(() => planPush({ ...PUSH, remote: "--upload-pack=x" }), /refusé/);
  assert.throws(() => planPush({ ...PUSH, remoteBranch: "a..b" }), /refusé/);
  assert.throws(() => planPush({ ...PUSH, commits: [] }), /commits/);
  assert.throws(() => planPush({ ...PUSH, commits: [{ sha: "--x", subject: "" }] }), /SHA/);
  assert.throws(() => planPush({ ...PUSH, files: [{ path: "../etc", status: "A" }] }), /chemin/);
});

test("mergePlanFingerprint et JSON canonique déterministes", () => {
  const input = { repo: "/r", branch: "nexus/task-1", targetHead: "c".repeat(40), branchTip: "d".repeat(40) };
  assert.equal(mergePlanFingerprint(input), mergePlanFingerprint({ ...input }));
  assert.notEqual(mergePlanFingerprint(input), mergePlanFingerprint({ ...input, branchTip: "e".repeat(40) }));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined, b: null }] }), '{"a":[2,{"b":null,"d":1}],"b":1}');
});

test("analyse des sorties -z", () => {
  assert.deepEqual(parsePorcelainZ(" M a b\0R  new\0old\0?? -x\0").entries, [
    { path: "a b", index: " ", worktree: "M" },
    { path: "new", origPath: "old", index: "R", worktree: " " },
    { path: "-x", index: "?", worktree: "?" },
  ]);
  assert.deepEqual(parseNameStatusZ("M\0a\0R087\0old\0new\0A\0\n\0").files, [
    { path: "a", status: "modified" },
    { path: "new", oldPath: "old", status: "renamed", similarity: 87 },
    { path: "\n", status: "added" },
  ]);
});

test("unsafeConfigKeys : clés exécutables en portée local/worktree, insensible à la casse, global ignoré", async () => {
  const { unsafeConfigKeys } = await import("../src/index.ts");
  const z = (...e: [string, string, string][]) => e.map(([s, k, v]) => `${s}\0${k}\n${v}\0`).join("");
  assert.deepEqual(
    unsafeConfigKeys(
      z(
        ["local", "core.hookspath", ".husky"],
        ["local", "filter.Pwn.clean", "x"],
        ["worktree", "merge.m.driver", "x"],
        ["local", "includeif.gitdir:/x/.path", "/y"],
        ["global", "filter.lfs.process", "git-lfs filter-process"],
        ["command", "diff.external", ""],
        ["local", "user.name", "x"],
      ),
    ),
    ["filter.pwn.clean", "merge.m.driver", "includeif.gitdir:/x/.path"],
  );
});
