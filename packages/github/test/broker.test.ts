import { test } from "node:test";
import assert from "node:assert/strict";
import { isGitHubError, type GitHubErrorCode } from "../src/index.ts";
import { approval, bareHead, commit, fakeGh, makeFixture, type Fixture } from "./helpers.ts";

const code = (c: GitHubErrorCode) => (e: unknown) => isGitHubError(e, c);
const FORCE = /^(?:-f|--force.*|--delete|-d|--mirror|--prune)$/;

/** Aucune commande lancée par le broker ne contient d'option de force/suppression ni de refspec `+`. */
function assertNoForce(fx: Fixture): void {
  for (const c of fx.calls) {
    for (const a of c.args) {
      assert.ok(!FORCE.test(a), `option interdite transmise : ${a}`);
      assert.ok(!a.startsWith("+"), `refspec forcé transmis : ${a}`);
    }
  }
}
const pushCalls = (fx: Fixture) => fx.calls.filter((c) => c.args.includes("push"));

async function prepared(fx: Fixture) {
  const sha = await commit(fx, "src/feature.txt", "nouvelle fonctionnalité\n", "feat: ajout");
  const plan = await fx.broker().preparePush(fx.repo, "feature/x", "origin");
  return { sha, plan };
}

test("preparePush : plan complet, remote sans identifiants, commits et fichiers non poussés", async (t) => {
  const fx = await makeFixture(t);
  const { sha, plan } = await prepared(fx);
  assert.equal(plan.blocked, false);
  assert.equal(plan.scanComplete, true);
  assert.equal(plan.headSha, sha);
  assert.equal(plan.protocol, "file");
  assert.equal(plan.push.plan.force, false);
  assert.deepEqual(
    plan.push.plan.commits.map((c) => c.sha),
    [sha],
  );
  assert.deepEqual(plan.push.plan.files, [{ path: "src/feature.txt", status: "A" }]);
  assert.match(plan.summary, /Push feature\/x -> origin\/feature\/x/);
  assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(pushCalls(fx).length, 0, "préparer ne pousse rien");

  // Identifiants retirés de l'URL affichée et de l'empreinte.
  const { g } = await import("./helpers.ts");
  await g(fx.home, fx.repo, "remote", "set-url", "origin", `file://user:s3cr3t-pass@localhost${fx.bare}`);
  const p2 = await fx.broker().preparePush(fx.repo, "feature/x", "origin");
  assert.ok(!JSON.stringify(p2).includes("s3cr3t-pass"));
});

test("push refusé sans approbation, approbation inconnue ou refusée : rien n'est poussé", async (t) => {
  const fx = await makeFixture(t);
  const { plan } = await prepared(fx);
  const broker = fx.broker();
  await assert.rejects(broker.push(fx.repo, plan, ""), code("approval_denied"));
  await assert.rejects(broker.push(fx.repo, plan, "00000000-0000-4000-8000-000000000000"), code("approval_denied"));
  const denied = await approval(fx, "git_push", plan.approvalPlan, { decision: "deny" });
  await assert.rejects(broker.push(fx.repo, plan, denied), code("approval_denied"));
  assert.equal(await bareHead(fx, "feature/x"), null);
  assert.equal(pushCalls(fx).length, 0);
});

test("push refusé avec une approbation expirée, pour un autre plan ou une autre action", async (t) => {
  const fx = await makeFixture(t);
  const { plan } = await prepared(fx);
  const broker = fx.broker();

  const expiring = await approval(fx, "git_push", plan.approvalPlan, { ttlMs: 1000 });
  fx.clock.now += 5000;
  await assert.rejects(broker.push(fx.repo, plan, expiring), code("approval_denied"));

  const other = await approval(fx, "git_push", { ...plan.approvalPlan, headSha: "0".repeat(40) });
  await assert.rejects(broker.push(fx.repo, plan, other), code("approval_denied"));

  const wrongAction = await approval(fx, "github_pr_create", plan.approvalPlan);
  await assert.rejects(broker.push(fx.repo, plan, wrongAction), code("approval_denied"));

  assert.equal(await bareHead(fx, "feature/x"), null);
  assert.equal(pushCalls(fx).length, 0);
});

test("push accepté une seule fois : commit présent dans le dépôt nu, approbation consommée", async (t) => {
  const fx = await makeFixture(t);
  const { sha, plan } = await prepared(fx);
  const broker = fx.broker();
  const id = await approval(fx, "git_push", plan.approvalPlan);
  const r = await broker.push(fx.repo, plan, id);
  assert.equal(r.sha, sha);
  assert.equal(r.flag, "*");
  assert.equal(await bareHead(fx, "feature/x"), sha);
  assert.equal((await fx.core.approvals.get(id)).status, "consumed");

  // Usage unique : la même approbation ne permet pas un second push (même avec un nouveau commit).
  await commit(fx, "src/feature.txt", "v2\n", "feat: v2");
  const plan2 = await broker.preparePush(fx.repo, "feature/x", "origin");
  assert.equal(plan2.push.plan.commits.length, 1, "seul le nouveau commit reste à pousser");
  await assert.rejects(broker.push(fx.repo, plan2, id), code("approval_denied"));
  assert.equal(await bareHead(fx, "feature/x"), sha);

  // Argv exact du push : commit approuvé -> réf explicite, protocoles restreints, hooks désactivés.
  const [call] = pushCalls(fx);
  assert.ok(call);
  const i = call.args.indexOf("push");
  assert.deepEqual(call.args.slice(i), [
    "push",
    "--porcelain",
    "--no-verify",
    "--no-recurse-submodules",
    "origin",
    `${sha}:refs/heads/feature/x`,
  ]);
  assert.ok(call.args.includes("protocol.allow=never"));
  assert.ok(call.args.includes("protocol.file.allow=always"));
  assert.ok(call.args.includes("core.hooksPath=/dev/null"));
  assert.equal(call.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(call.env.HOME, fx.home);
  assert.deepEqual(Object.keys(call.env).sort(), ["GIT_TERMINAL_PROMPT", "HOME", "LANG", "LC_ALL", "PATH"]);
  assertNoForce(fx);
});

test("plan bloqué si le diff contient un secret (ghp_, sk-), même retiré dans un commit ultérieur", async (t) => {
  const fx = await makeFixture(t);
  await commit(fx, "config.js", `const t = "ghp_${"a".repeat(36)}";\n`, "oops");
  await commit(fx, "config.js", "const t = process.env.T;\n", "fix");
  const broker = fx.broker();
  const plan = await broker.preparePush(fx.repo, "feature/x", "origin");
  assert.equal(plan.blocked, true);
  assert.deepEqual(plan.blockedReasons, ["secret_detected"]);
  assert.equal(plan.push.plan.secretFindings[0]?.rule, "github_token");
  assert.ok(!JSON.stringify(plan).includes("a".repeat(36)), "la valeur n'apparaît jamais dans le plan");
  // Même approuvé, un plan bloqué n'est pas exécuté et l'approbation n'est pas consommée.
  const id = await approval(fx, "git_push", plan.approvalPlan);
  await assert.rejects(broker.push(fx.repo, plan, id), code("plan_blocked"));
  assert.equal((await fx.core.approvals.get(id)).status, "allowed");
  // Un plan falsifié (blocked: false) ne passe pas : son empreinte diffère de l'état réel.
  const forged = {
    ...plan,
    blocked: false,
    blockedReasons: [],
    approvalPlan: { ...plan.approvalPlan, blocked: false },
    push: { ...plan.push, plan: { ...plan.push.plan, secretFindings: [] } },
  };
  await assert.rejects(broker.push(fx.repo, forged, id), code("approval_denied"));

  const fx2 = await makeFixture(t);
  await commit(fx2, "k.txt", `OPENAI=sk-${"b".repeat(40)}\n`, "clé");
  const plan2 = await fx2.broker().preparePush(fx2.repo, "feature/x", "origin");
  assert.equal(plan2.blocked, true);
  assert.equal(plan2.push.plan.secretFindings[0]?.rule, "openai_key");
  assert.equal(await bareHead(fx, "feature/x"), null);
});

test("protocole non autorisé refusé, à la préparation comme au push, sans consommer l'approbation", async (t) => {
  const fx = await makeFixture(t);
  const { plan } = await prepared(fx);
  const httpsOnly = fx.broker({ allowedProtocols: ["https", "ssh"] });
  await assert.rejects(httpsOnly.preparePush(fx.repo, "feature/x", "origin"), code("protocol_not_allowed"));
  const id = await approval(fx, "git_push", plan.approvalPlan);
  await assert.rejects(httpsOnly.push(fx.repo, plan, id), code("protocol_not_allowed"));
  assert.equal((await fx.core.approvals.get(id)).status, "allowed");
  assert.equal(pushCalls(fx).length, 0);
  // `ext::` (exécution de commande) n'est jamais autorisable.
  assert.throws(() => fx.broker({ allowedProtocols: ["ext"] }), code("invalid_argument"));
});

test("état modifié après approbation : refus, rien n'est poussé", async (t) => {
  const fx = await makeFixture(t);
  const { plan } = await prepared(fx);
  const broker = fx.broker();
  const id = await approval(fx, "git_push", plan.approvalPlan);
  await commit(fx, "src/other.txt", "ajout après approbation\n", "feat: non approuvé");
  await assert.rejects(broker.push(fx.repo, plan, id), code("state_changed"));
  assert.equal(await bareHead(fx, "feature/x"), null);
  assert.equal(pushCalls(fx).length, 0);
  assertNoForce(fx);
});

test("rien à pousser, branche ou remote inconnus, noms invalides", async (t) => {
  const fx = await makeFixture(t);
  const broker = fx.broker();
  await assert.rejects(broker.preparePush(fx.repo, "feature/x", "origin"), code("nothing_to_push"));
  await assert.rejects(broker.preparePush(fx.repo, "absente", "origin"), code("branch_not_found"));
  await assert.rejects(broker.preparePush(fx.repo, "feature/x", "upstream"), code("remote_not_found"));
  await assert.rejects(broker.preparePush(fx.repo, "--force", "origin"), code("invalid_argument"));
  await assert.rejects(broker.preparePush(fx.repo, "+main", "origin"), code("invalid_argument"));
});

test("pull request : approbation consommée, corps sur stdin, URL extraite", async (t) => {
  const fx = await makeFixture(t);
  const gh = fakeGh(fx.root);
  const broker = fx.broker({ ghPath: gh.path });
  const input = {
    title: "Ajout de la fonctionnalité",
    body: "Description\nsur plusieurs lignes\n",
    base: "main",
    head: "feature/x",
  };

  await assert.rejects(broker.createPullRequest(fx.repo, input, ""), code("approval_denied"));
  assert.equal(gh.argv().length, 0, "gh n'est pas lancé sans approbation");

  const prep = await broker.preparePullRequest(fx.repo, input);
  const id = await approval(fx, "github_pr_create", prep.approvalPlan);
  // Une approbation de PR pour un autre titre ne vaut pas.
  await assert.rejects(broker.createPullRequest(fx.repo, { ...input, title: "Autre" }, id), code("approval_denied"));
  assert.equal(gh.argv().length, 0);
  const r = await broker.createPullRequest(fx.repo, input, id);
  assert.equal(r.url, "https://github.com/octo/repo/pull/42");
  assert.deepEqual(gh.argv(), [
    ["pr", "create", "--title", input.title, "--body-file", "-", "--base", "main", "--head", "feature/x"],
  ]);
  assert.equal(gh.stdin(), input.body);
  assert.ok(gh.env().includes("GH_PROMPT_DISABLED=1"));
  assert.ok(!/GH_TOKEN|GITHUB_TOKEN/.test(gh.env()), "aucun jeton transmis par Nexus");
  await assert.rejects(broker.createPullRequest(fx.repo, input, id), code("approval_denied"), "usage unique");
});

test("gh absent : PR `unavailable` sans consommer l'approbation, sonde et statut honnêtes", async (t) => {
  const fx = await makeFixture(t);
  const broker = fx.broker();
  const input = { title: "PR", body: "", base: "main", head: "feature/x" };
  const prep = await broker.preparePullRequest(fx.repo, input);
  const id = await approval(fx, "github_pr_create", prep.approvalPlan);
  await assert.rejects(broker.createPullRequest(fx.repo, input, id), code("unavailable"));
  assert.equal((await fx.core.approvals.get(id)).status, "allowed");
  assert.deepEqual(await broker.probe(), { available: false, reason: "not_configured", verifiedAgainstRealCli: false });
  assert.equal((await broker.authStatus()).state, "unknown");
  // Chemin configuré mais binaire inexistant.
  const missing = fx.broker({ ghPath: `${fx.root}/nope/gh` });
  assert.equal((await missing.probe()).available, false);
  await assert.rejects(missing.createPullRequest(fx.repo, input, id), code("unavailable"));
});

test("probe et authStatus via la fausse CLI : version, compte, stockage, jeton jamais exposé", async (t) => {
  const fx = await makeFixture(t);
  const gh = fakeGh(fx.root);
  const broker = fx.broker({ ghPath: gh.path });
  const p = await broker.probe();
  assert.equal(p.available, true);
  assert.equal(p.version, "2.99.0");
  assert.equal(p.verifiedAgainstRealCli, false);
  const s = await broker.authStatus();
  assert.equal(s.state, "authenticated");
  assert.deepEqual(s.accounts, [{ host: "github.com", login: "octo", storage: "keyring" }]);
  assert.equal(s.insecureStorage, false);
  assert.deepEqual(gh.argv()[1], ["auth", "status"]);

  const fx2 = await makeFixture(t);
  const leaky = fakeGh(fx2.root, {
    authOutput: `github.com\n  ✓ Logged in to github.com as octo (/home/u/.config/gh/hosts.yml)\n  - Token: gho_${"Z".repeat(36)}\n`,
  });
  const s2 = await fx2.broker({ ghPath: leaky.path }).authStatus();
  assert.equal(s2.insecureStorage, true);
  assert.ok(!s2.output.includes("Z".repeat(36)), "jeton expurgé");

  const fx3 = await makeFixture(t);
  const out = fakeGh(fx3.root, {
    authOutput: "You are not logged into any GitHub hosts. To log in, run: gh auth login\n",
    authCode: 1,
  });
  assert.equal((await fx3.broker({ ghPath: out.path }).authStatus()).state, "unauthenticated");
});

test("push refusé si la config locale du dépôt définit une commande (core.sshCommand) : rien n'est lancé", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const fx = await makeFixture(t);
  const { plan } = await prepared(fx);
  const broker = fx.broker();
  const id = await approval(fx, "git_push", plan.approvalPlan);
  const marker = join(fx.repo, "..", "ssh-marker");
  execFileSync("git", ["-C", fx.repo, "config", "--local", "core.sshCommand", `touch ${marker}`]);
  await assert.rejects(broker.push(fx.repo, plan, id), code("plan_blocked"));
  assert.equal(pushCalls(fx).length, 0);
  assert.equal(existsSync(marker), false);
  assert.equal(await bareHead(fx, "feature/x"), null);
});
