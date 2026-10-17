// Git broker sur de vrais dépôts temporaires : worktrees isolés, concurrence, conflits (AC-03), merge approuvé.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitBroker, isGitError, type GitErrorCode } from "../src/index.ts";
import { AUTHOR, g, GIT, head, makeRepo, write } from "./helpers.ts";

const rejectsWith = (p: Promise<unknown>, code: GitErrorCode) =>
  assert.rejects(p, (e: unknown) => {
    assert.ok(
      isGitError(e, code),
      `attendu ${code}, obtenu ${(e as Error)?.constructor?.name}:${(e as { code?: string }).code} ${(e as Error).message}`,
    );
    return true;
  });

test("constructeur : chemins absolus exigés", () => {
  assert.throws(() => new GitBroker({ gitPath: "git", home: "/tmp", worktreesRoot: "/tmp/w" }), /absolu/);
  assert.throws(() => new GitBroker({ gitPath: GIT!, home: "rel", worktreesRoot: "/tmp/w" }), /absolu/);
  assert.throws(() => new GitBroker({ gitPath: GIT!, home: "/tmp", worktreesRoot: "w" }), /absolu/);
});

test("status / currentBranch / NOT_A_REPOSITORY", async (t) => {
  const fx = await makeRepo(t);
  assert.equal(await fx.broker.currentBranch(fx.repo), "main");
  const st = await fx.broker.status(fx.repo);
  assert.equal(st.clean, true);
  write(fx.repo, "nouveau.txt", "x");
  write(fx.repo, "src/app.txt", "modifié\n");
  const st2 = await fx.broker.status(fx.repo);
  assert.equal(st2.clean, false);
  assert.deepEqual(st2.entries.map((e) => [e.path, e.index + e.worktree]).sort(), [
    ["nouveau.txt", "??"],
    ["src/app.txt", " M"],
  ]);
  await rejectsWith(fx.broker.status(fx.home), "NOT_A_REPOSITORY");
  await rejectsWith(fx.broker.status(join(fx.repo, "src")), "NOT_A_REPOSITORY"); // pas une racine
});

test("création / suppression d'un worktree isolé hors du dépôt principal", async (t) => {
  const fx = await makeRepo(t);
  const wt = await fx.broker.createTaskWorktree(fx.repo, "T-1", "main");
  assert.equal(wt.branch, "nexus/task-T-1");
  assert.equal(wt.baseCommit, await head(fx, fx.repo));
  assert.ok(wt.path.startsWith(fx.wtRoot + "/"), wt.path);
  assert.ok(!wt.path.startsWith(fx.repo + "/"));
  assert.equal(readFileSync(join(wt.path, "README.md"), "utf8"), "# fixture\n");
  assert.equal(await fx.broker.currentBranch(wt.path), "nexus/task-T-1");
  assert.equal(await fx.broker.currentBranch(fx.repo), "main", "le dépôt principal reste sur sa branche");
  assert.deepEqual(
    (await fx.broker.listTaskWorktrees(fx.repo)).map((w) => w.branch),
    ["nexus/task-T-1"],
  );

  await rejectsWith(fx.broker.createTaskWorktree(fx.repo, "T-1", "main"), "WORKTREE_EXISTS");
  await rejectsWith(fx.broker.createTaskWorktree(wt.path, "T-9", "main"), "NOT_MAIN_WORKTREE");

  await fx.broker.removeWorktree(fx.repo, wt.path, { deleteBranch: true });
  assert.equal(existsSync(wt.path), false);
  assert.deepEqual(await fx.broker.listTaskWorktrees(fx.repo), []);
  assert.equal((await g(fx, fx.repo, "branch", "--list", "nexus/*")).trim(), "");
  await rejectsWith(fx.broker.removeWorktree(fx.repo, fx.repo), "NOT_TASK_WORKTREE");
});

test("racine des worktrees à l'intérieur du dépôt refusée", async (t) => {
  const fx = await makeRepo(t);
  const b = new GitBroker({ gitPath: GIT!, home: fx.home, worktreesRoot: join(fx.repo, "wt") });
  await rejectsWith(b.createTaskWorktree(fx.repo, "T-1", "main"), "WORKTREE_ROOT_INSIDE_REPO");
});

test("écriture + commit dans le worktree sans modifier le dépôt principal", async (t) => {
  const fx = await makeRepo(t);
  const before = await head(fx, fx.repo);
  const wt = await fx.broker.createTaskWorktree(fx.repo, "T-2", "main");
  write(wt.path, "src/app.txt", "ligne 1\nligne 2 (tâche)\nligne 3\n");
  write(wt.path, "feature.txt", "nouvelle fonctionnalité\n");

  const d = await fx.broker.diff(wt.path);
  assert.deepEqual(
    d.files.map((f) => [f.path, f.status]),
    [["src/app.txt", "modified"]],
  ); // non suivi : hors diff HEAD
  assert.match(d.unified, /\+ligne 2 \(tâche\)/);

  const c = await fx.broker.commitAll(wt.path, "feat: tâche 2", AUTHOR);
  assert.equal(c.branch, "nexus/task-T-2");
  assert.equal(await head(fx, wt.path), c.commit);
  assert.equal(await head(fx, fx.repo), before, "HEAD principal inchangé");
  assert.equal((await fx.broker.status(fx.repo)).clean, true, "worktree principal propre");
  assert.equal(readFileSync(join(fx.repo, "src/app.txt"), "utf8"), "ligne 1\nligne 2\nligne 3\n");
  assert.equal(existsSync(join(fx.repo, "feature.txt")), false);
  assert.equal((await g(fx, wt.path, "log", "-1", "--format=%an <%ae>")).trim(), `${AUTHOR.name} <${AUTHOR.email}>`);

  // Revue de la branche de tâche contre main.
  const review = await fx.broker.diff(fx.repo, { base: "main", head: "nexus/task-T-2" });
  assert.deepEqual(review.files.map((f) => [f.path, f.status]).sort(), [
    ["feature.txt", "added"],
    ["src/app.txt", "modified"],
  ]);
  assert.equal(review.truncated, false);
  assert.equal(review.secretsScanComplete, true);

  await rejectsWith(fx.broker.commitAll(wt.path, "rien", AUTHOR), "NOTHING_TO_COMMIT");
  // commitAll refusé dans le dépôt principal.
  write(fx.repo, "intrus.txt", "x");
  await rejectsWith(fx.broker.commitAll(fx.repo, "interdit", AUTHOR), "NOT_TASK_WORKTREE");
  await rejectsWith(fx.broker.assertMainWorktreeClean(fx.repo), "MAIN_WORKTREE_DIRTY");
  assert.deepEqual(
    (await fx.broker.mainWorktreeChanges(fx.repo)).map((e) => e.path),
    ["intrus.txt"],
  );
});

test("diff borné en taille", async (t) => {
  const fx = await makeRepo(t);
  const wt = await fx.broker.createTaskWorktree(fx.repo, "big", "main");
  write(wt.path, "src/app.txt", "x".repeat(10_000) + "\n");
  const d = await fx.broker.diff(wt.path, { maxBytes: 1024 });
  assert.equal(d.truncated, true);
  assert.ok(Buffer.byteLength(d.unified) <= 1024);
  assert.ok(d.unifiedBytes > 10_000);
});

test("deux worktrees concurrents restent isolés", async (t) => {
  const fx = await makeRepo(t);
  const [a, b] = await Promise.all([
    fx.broker.createTaskWorktree(fx.repo, "A", "main"),
    fx.broker.createTaskWorktree(fx.repo, "B", "main"),
  ]);
  assert.notEqual(a.path, b.path);
  write(a.path, "a.txt", "A\n");
  write(b.path, "b.txt", "B\n");
  const [ca, cb] = await Promise.all([
    fx.broker.commitAll(a.path, "A", AUTHOR),
    fx.broker.commitAll(b.path, "B", AUTHOR),
  ]);
  assert.notEqual(ca.commit, cb.commit);
  assert.equal(existsSync(join(a.path, "b.txt")), false);
  assert.equal(existsSync(join(b.path, "a.txt")), false);
  assert.equal((await fx.broker.status(fx.repo)).clean, true);
  assert.deepEqual((await fx.broker.listTaskWorktrees(fx.repo)).map((w) => w.branch).sort(), [
    "nexus/task-A",
    "nexus/task-B",
  ]);
});

test("merge refusé sans approbation, ou avec une approbation qui ne correspond pas", async (t) => {
  const fx = await makeRepo(t);
  const wt = await fx.broker.createTaskWorktree(fx.repo, "M", "main");
  write(wt.path, "m.txt", "m\n");
  await fx.broker.commitAll(wt.path, "m", AUTHOR);
  const before = await head(fx, fx.repo);
  for (const fp of [undefined, "", "   ", "abc", "Z".repeat(64)]) {
    await rejectsWith(
      fx.broker.mergeTaskBranch(fx.repo, "nexus/task-M", { approvalFingerprint: fp as string, author: AUTHOR }),
      "APPROVAL_REQUIRED",
    );
  }
  await rejectsWith(
    fx.broker.mergeTaskBranch(fx.repo, "nexus/task-M", { approvalFingerprint: "a".repeat(64), author: AUTHOR }),
    "APPROVAL_MISMATCH",
  );
  // Approbation périmée : la branche a avancé après le plan.
  const plan = await fx.broker.planMerge(fx.repo, "nexus/task-M");
  write(wt.path, "m2.txt", "m2\n");
  await fx.broker.commitAll(wt.path, "m2", AUTHOR);
  await rejectsWith(
    fx.broker.mergeTaskBranch(fx.repo, "nexus/task-M", { approvalFingerprint: plan.fingerprint, author: AUTHOR }),
    "APPROVAL_MISMATCH",
  );
  assert.equal(await head(fx, fx.repo), before);
  assert.equal((await fx.broker.status(fx.repo)).clean, true);
  // Seules les branches de tâche sont fusionnables par le broker.
  await rejectsWith(
    fx.broker.mergeTaskBranch(fx.repo, "main", { approvalFingerprint: "a".repeat(64), author: AUTHOR }),
    "INVALID_REF",
  );
});

test("merge approuvé : commit --no-ff avec trace de l'approbation", async (t) => {
  const fx = await makeRepo(t);
  const wt = await fx.broker.createTaskWorktree(fx.repo, "OK", "main");
  write(wt.path, "ok.txt", "ok\n");
  await fx.broker.commitAll(wt.path, "ok", AUTHOR);
  const plan = await fx.broker.planMerge(fx.repo, "nexus/task-OK");
  assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await fx.broker.planMerge(fx.repo, "nexus/task-OK")).fingerprint, plan.fingerprint);
  const r = await fx.broker.mergeTaskBranch(fx.repo, "nexus/task-OK", {
    approvalFingerprint: plan.fingerprint,
    author: AUTHOR,
  });
  assert.equal(r.status, "merged");
  if (r.status !== "merged") return;
  assert.deepEqual(
    r.files.map((f) => [f.path, f.status]),
    [["ok.txt", "added"]],
  );
  assert.equal(
    (await g(fx, fx.repo, "rev-list", "--parents", "-n", "1", "HEAD")).trim().split(" ").length,
    3,
    "commit de merge à 2 parents",
  );
  assert.match(await g(fx, fx.repo, "log", "-1", "--format=%B"), new RegExp(`Nexus-Approval: ${plan.fingerprint}`));
  assert.equal((await fx.broker.status(fx.repo)).clean, true);
  // Deuxième merge : rien à fusionner.
  const plan2 = await fx.broker.planMerge(fx.repo, "nexus/task-OK");
  const r2 = await fx.broker.mergeTaskBranch(fx.repo, "nexus/task-OK", {
    approvalFingerprint: plan2.fingerprint,
    author: AUTHOR,
  });
  assert.equal(r2.status, "up_to_date");
});

test("AC-03 : conflit simulé remonté sans écrasement, dépôt principal intact", async (t) => {
  const fx = await makeRepo(t);
  const a = await fx.broker.createTaskWorktree(fx.repo, "CA", "main");
  const b = await fx.broker.createTaskWorktree(fx.repo, "CB", "main");
  write(a.path, "src/app.txt", "ligne 1\nligne 2 (A)\nligne 3\n");
  write(b.path, "src/app.txt", "ligne 1\nligne 2 (B)\nligne 3\n");
  write(b.path, "b-only.txt", "b\n");
  await fx.broker.commitAll(a.path, "A", AUTHOR);
  await fx.broker.commitAll(b.path, "B", AUTHOR);

  const pa = await fx.broker.planMerge(fx.repo, "nexus/task-CA");
  assert.equal(
    (await fx.broker.mergeTaskBranch(fx.repo, "nexus/task-CA", { approvalFingerprint: pa.fingerprint, author: AUTHOR }))
      .status,
    "merged",
  );
  const afterA = await head(fx, fx.repo);
  const contentA = readFileSync(join(fx.repo, "src/app.txt"), "utf8");

  const pb = await fx.broker.planMerge(fx.repo, "nexus/task-CB");
  const r = await fx.broker.mergeTaskBranch(fx.repo, "nexus/task-CB", {
    approvalFingerprint: pb.fingerprint,
    author: AUTHOR,
  });
  assert.deepEqual(r, { status: "conflict", files: ["src/app.txt"] });
  assert.equal(await head(fx, fx.repo), afterA, "HEAD inchangé");
  assert.equal(
    readFileSync(join(fx.repo, "src/app.txt"), "utf8"),
    contentA,
    "aucun écrasement, aucun marqueur de conflit",
  );
  assert.equal(existsSync(join(fx.repo, "b-only.txt")), false);
  assert.equal((await fx.broker.status(fx.repo)).clean, true);
  assert.equal(existsSync(join(fx.repo, ".git", "MERGE_HEAD")), false, "aucun merge laissé en cours");
  // Le travail de la tâche B est intact dans son worktree.
  assert.equal(readFileSync(join(b.path, "src/app.txt"), "utf8"), "ligne 1\nligne 2 (B)\nligne 3\n");
});

test("merge refusé si le worktree principal contient des modifications", async (t) => {
  const fx = await makeRepo(t);
  const wt = await fx.broker.createTaskWorktree(fx.repo, "D", "main");
  write(wt.path, "d.txt", "d\n");
  await fx.broker.commitAll(wt.path, "d", AUTHOR);
  const plan = await fx.broker.planMerge(fx.repo, "nexus/task-D");
  write(fx.repo, "README.md", "modification locale non commitée\n");
  await rejectsWith(
    fx.broker.mergeTaskBranch(fx.repo, "nexus/task-D", { approvalFingerprint: plan.fingerprint, author: AUTHOR }),
    "MAIN_WORKTREE_DIRTY",
  );
  assert.equal(readFileSync(join(fx.repo, "README.md"), "utf8"), "modification locale non commitée\n");
});

test("noms de branche/réf malveillants refusés avant toute exécution", async (t) => {
  const fx = await makeRepo(t);
  const evil = [
    "--upload-pack=x",
    "-x",
    "a..b",
    "a b",
    "a\nb",
    "a\u0007b",
    "HEAD@{1}",
    "@",
    ".hidden",
    "a/.b",
    "x.lock",
    "a/",
    "a//b",
    "a~1",
    "a^",
    "a:b",
    "a?",
    "a*",
    "a[",
    "a\\b",
    "",
  ];
  for (const ref of evil) {
    await rejectsWith(fx.broker.createTaskWorktree(fx.repo, "T-E", ref), "INVALID_REF");
    await rejectsWith(fx.broker.diff(fx.repo, { base: ref }), "INVALID_REF");
  }
  for (const id of ["--upload-pack=x", "-x", "a..b", "a/b", "a b", ""]) {
    await rejectsWith(fx.broker.createTaskWorktree(fx.repo, id, "main"), "INVALID_ARGUMENT");
  }
  for (const br of ["--upload-pack=x", "-x", "nexus/task-a..b", "nexus/task--x", "feature/x"]) {
    await rejectsWith(fx.broker.planMerge(fx.repo, br), "INVALID_REF");
  }
  assert.deepEqual(await fx.broker.listTaskWorktrees(fx.repo), []);
  assert.equal(existsSync(join(fx.repo, "x")), false);
});

test("chemin commençant par '-' traité comme un chemin, jamais comme une option", async (t) => {
  const fx = await makeRepo(t);
  const wt = await fx.broker.createTaskWorktree(fx.repo, "P", "main");
  write(wt.path, "--output=pwned", "avant\n");
  write(wt.path, "-rf", "avant\n");
  await fx.broker.commitAll(wt.path, "fichiers piégés", AUTHOR);
  write(wt.path, "--output=pwned", "après\n");
  write(wt.path, "-rf", "après\n");
  write(wt.path, "README.md", "autre\n");
  const d = await fx.broker.diff(wt.path, { paths: ["--output=pwned"] });
  assert.deepEqual(
    d.files.map((f) => f.path),
    ["--output=pwned"],
  );
  assert.equal(existsSync(join(wt.path, "pwned")), false, "--output n'a pas été interprété");
  const d2 = await fx.broker.diff(wt.path, { paths: ["-rf"] });
  assert.deepEqual(
    d2.files.map((f) => f.path),
    ["-rf"],
  );
  // Pathspec magique désactivée : ':(top)' est un nom littéral (absent) et non une directive.
  const d3 = await fx.broker.diff(wt.path, { paths: [":(top)"] });
  assert.deepEqual(d3.files, []);
  for (const bad of ["/etc/passwd", "../x", "a/../../b", "a\u0000b"]) {
    await rejectsWith(fx.broker.diff(wt.path, { paths: [bad] }), "INVALID_PATH");
  }
});

test("diff : secrets détectés sur la valeur réelle et masqués dans le texte renvoyé", async (t) => {
  const fx = await makeRepo(t);
  const wt = await fx.broker.createTaskWorktree(fx.repo, "S", "main");
  const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  write(wt.path, "config.js", `export const t = "${token}";\n`);
  write(wt.path, ".env", "API=1\n");
  await fx.broker.commitAll(wt.path, "oops", AUTHOR);
  const d = await fx.broker.diff(fx.repo, { base: "main", head: "nexus/task-S" });
  assert.deepEqual(d.secrets.map((s) => [s.rule, s.file, s.line]).sort(), [
    ["env_file_added", ".env", 0],
    ["github_token", "config.js", 1],
  ]);
  assert.ok(!d.unified.includes(token));
  assert.ok(!JSON.stringify(d.secrets).includes(token));
});

// ------------------------------------------------------------------ config du dépôt contrôlée par l'agent

test("filtre clean malveillant dans la config du dépôt : commitAll refuse, aucune commande exécutée", async (t) => {
  const fx = await makeRepo(t);
  const wt = await fx.broker.createTaskWorktree(fx.repo, "T-F", "main");
  const marker = join(fx.root, "PWNED");
  // Config légitime courante (husky) : neutralisée par -c, n'empêche pas le commit.
  await g(fx, fx.repo, "config", "core.hooksPath", ".husky");
  write(wt.path, "ok.txt", "ok\n");
  await fx.broker.commitAll(wt.path, "ok", AUTHOR);

  await g(fx, fx.repo, "config", "filter.pwn.clean", `touch ${marker}; cat`);
  write(wt.path, ".gitattributes", "* filter=pwn\n");
  write(wt.path, "src/app.txt", "modifié par l'agent\n");
  await rejectsWith(fx.broker.commitAll(wt.path, "tâche", AUTHOR), "UNSAFE_REPO_CONFIG");
  await rejectsWith(fx.broker.status(wt.path), "UNSAFE_REPO_CONFIG");
  await rejectsWith(fx.broker.diff(wt.path), "UNSAFE_REPO_CONFIG");
  await rejectsWith(fx.broker.createTaskWorktree(fx.repo, "T-G", "main"), "UNSAFE_REPO_CONFIG");
  assert.equal(existsSync(marker), false, "le filtre n'a jamais été lancé par le broker");

  // Contrôle (rouge sans la vérification) : git brut exécute bien le filtre sur l'hôte.
  await g(fx, wt.path, "add", "--all");
  assert.equal(existsSync(marker), true);
});

test("include et config de worktree : refusés (UNSAFE_REPO_CONFIG)", async (t) => {
  const fx = await makeRepo(t);
  const wt = await fx.broker.createTaskWorktree(fx.repo, "T-I", "main");
  const marker = join(fx.root, "PWNED");
  const inc = join(fx.root, "evil.inc");
  write(fx.root, "evil.inc", `[filter "x"]\n\tsmudge = touch ${marker}; cat\n`);
  await g(fx, fx.repo, "config", "include.path", inc);
  await rejectsWith(fx.broker.commitAll(wt.path, "m", AUTHOR), "UNSAFE_REPO_CONFIG");
  await g(fx, fx.repo, "config", "--unset", "include.path");

  await g(fx, fx.repo, "config", "extensions.worktreeConfig", "true");
  await g(fx, wt.path, "config", "--worktree", "merge.x.driver", `touch ${marker}`);
  write(wt.path, "a.txt", "a\n");
  await rejectsWith(fx.broker.commitAll(wt.path, "m", AUTHOR), "UNSAFE_REPO_CONFIG");
  // Le dépôt principal n'est pas concerné par la config propre au worktree.
  assert.equal((await fx.broker.status(fx.repo)).clean, true);
  assert.equal(existsSync(marker), false);
});

test("pointeur gitdir falsifié dans un worktree de tâche : refusé", async (t) => {
  const fx = await makeRepo(t);
  const a = await fx.broker.createTaskWorktree(fx.repo, "T-A", "main");
  const b = await fx.broker.createTaskWorktree(fx.repo, "T-B", "main");
  const pointerA = readFileSync(join(a.path, ".git"), "utf8");
  const pointerB = readFileSync(join(b.path, ".git"), "utf8");

  // 1. Pointeur vers le gitdir d'un autre worktree : le pointeur retour ne correspond pas.
  writeFileSync(join(a.path, ".git"), pointerB);
  write(a.path, "x.txt", "x\n");
  await rejectsWith(fx.broker.commitAll(a.path, "m", AUTHOR), "NOT_TASK_WORKTREE");

  // 2. Pointeur vers un gitdir fabriqué dans le worktree (commondir contrôlé par l'agent).
  const fake = join(a.path, ".fake");
  await g(fx, fx.root, "init", "--quiet", "--bare", fake);
  write(fake, "worktrees/x/HEAD", "ref: refs/heads/nexus/task-T-A\n");
  write(fake, "worktrees/x/commondir", "../..\n");
  write(fake, "worktrees/x/gitdir", `${join(a.path, ".git")}\n`);
  writeFileSync(join(a.path, ".git"), `gitdir: ${join(fake, "worktrees", "x")}\n`);
  await assert.rejects(fx.broker.commitAll(a.path, "m", AUTHOR), (e: unknown) => {
    assert.ok(isGitError(e, "NOT_TASK_WORKTREE") || isGitError(e, "NOT_A_REPOSITORY"), String(e));
    return true;
  });

  // Pointeur restauré : le worktree est de nouveau accepté.
  writeFileSync(join(a.path, ".git"), pointerA);
  await fx.broker.commitAll(a.path, "m", AUTHOR);
});
