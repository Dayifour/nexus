// T-014 — isolation Linux réelle sur fixtures inoffensives (AC-06, AC-07, SEC-001..008).
// Sans user namespaces ni bwrap, la suite ÉCHOUE (pas de faux vert), sauf NEXUS_ALLOW_NO_USERNS=1 explicite.
import { before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxProfile } from "@nexus/contracts";
import {
  buildBwrapArgs,
  createSandboxedRunner,
  gitMetadataPaths,
  isForbiddenAddress,
  proxyBridgePath,
  probeSandbox,
  sandboxUsable,
  startEgressProxy,
  type SandboxCapabilities,
} from "../src/index.ts";

let caps: SandboxCapabilities;
before(async () => {
  caps = await probeSandbox();
  // Hors Linux, aucun backend n'existe : les preuves d'isolation sont ignorées, le refus d'exécution reste vérifié.
  if (process.platform === "linux" && !sandboxUsable(caps) && process.env.NEXUS_ALLOW_NO_USERNS !== "1") {
    throw new Error(`sandbox indisponible (${caps.reasons.join("; ")}) : refus, pas de faux vert`);
  }
});
const sb = (name: string, fn: (t: TestContext) => Promise<void>) =>
  test(name, (t) => (sandboxUsable(caps) ? fn(t) : t.skip(caps.reasons.join("; "))));

const NODE = "/opt/nexus/bin/node";

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nexus-sbx-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ws = join(root, "ws");
  const outside = join(root, "outside");
  mkdirSync(join(ws, "config"), { recursive: true });
  mkdirSync(join(ws, ".ssh"));
  mkdirSync(outside);
  writeFileSync(join(ws, "README.md"), "workspace\n");
  writeFileSync(join(ws, ".env"), "FIXTURE_ENV=visible-by-default\n");
  writeFileSync(join(ws, "config", ".env.local"), "FIXTURE_LOCAL=x\n");
  writeFileSync(join(ws, ".npmrc"), "//registry/:_authToken=FIXTURE_NPM_TOKEN\n");
  writeFileSync(join(ws, ".ssh", "id_ed25519"), "FIXTURE_SSH\n");
  writeFileSync(join(outside, "secret.txt"), "FIXTURE_OUTSIDE\n");
  symlinkSync(join(outside, "secret.txt"), join(ws, "escape-link"));
  return { root, ws, outside };
}

function profile(ws: string, over: Partial<SandboxProfile> = {}): SandboxProfile {
  return {
    workspace: ws,
    readOnlyBinds: [[process.execPath, NODE]],
    protectEnvFiles: false,
    network: { mode: "none" },
    env: { NEXUS_TASK_ID: "task-1" },
    limits: {},
    ...over,
  };
}

async function inSandbox(
  p: SandboxProfile,
  script: string,
  opts: { signal?: AbortSignal; egressSocketPath?: string; timeoutMs?: number } = {},
) {
  const run = createSandboxedRunner(p, caps, opts.egressSocketPath ? { egressSocketPath: opts.egressSocketPath } : {});
  const out: string[] = [];
  const err: string[] = [];
  const r = await run({
    file: NODE,
    args: ["-e", script],
    cwd: p.workspace,
    env: { SHOULD_BE_IGNORED: "1" },
    timeoutMs: opts.timeoutMs ?? 20_000,
    ...(opts.signal && { signal: opts.signal }),
    onLine: (l, ch) => (ch === "stdout" ? out : err).push(l),
  });
  let json: any;
  try {
    json = out.length ? JSON.parse(out.join("\n")) : undefined;
  } catch {
    json = out.join("\n");
  }
  return { r, json, stderr: err.join("\n") };
}

const TRY = `const fs=require('fs');
const tryRead=p=>{try{return 'READ:'+fs.readFileSync(p,'utf8').trim()}catch(e){return e.code}};
const tryWrite=p=>{try{fs.writeFileSync(p,'x');return 'WROTE'}catch(e){return e.code}};`;

sb("capacités : bwrap, PID namespace et seccomp disponibles sur l'hôte de développement", async () => {
  assert.equal(caps.bwrap && caps.pidNamespace && caps.seccomp, true, caps.reasons.join("; "));
});

sb(
  "workspace lisible et inscriptible ; hors workspace et HOME hôte invisibles ; système en lecture seule",
  async (t) => {
    const { ws, outside } = fixture(t);
    const { json } = await inSandbox(
      profile(ws),
      `${TRY} console.log(JSON.stringify({ readme: tryRead('/workspace/README.md'), write: tryWrite('/workspace/out.txt'),
     outside: tryRead(${JSON.stringify(join(outside, "secret.txt"))}), link: tryRead('/workspace/escape-link'),
     hostHome: fs.existsSync(${JSON.stringify(process.env.HOME ?? "/home")}), etc: tryWrite('/etc/x'), root: tryWrite('/x'),
     usr: tryWrite('/usr/x'), home: process.env.HOME, env: Object.keys(process.env).sort() }))`,
    );
    assert.equal(json.readme, "READ:workspace");
    assert.equal(json.write, "WROTE");
    assert.equal(readFileSync(join(ws, "out.txt"), "utf8"), "x");
    assert.equal(json.outside, "ENOENT");
    assert.equal(json.link, "ENOENT");
    assert.equal(json.hostHome, false);
    assert.deepEqual([json.etc, json.root, json.usr], ["EROFS", "EROFS", "EROFS"]);
    assert.equal(json.home, "/home/agent");
    assert.deepEqual(
      json.env,
      ["HOME", "LANG", "NEXUS_TASK_ID", "PATH", "PWD", "TMPDIR"],
      "environnement du profil seulement",
    );
  },
);

sb("D-4 : .env VISIBLE par défaut ; identifiants (.npmrc, clé SSH) toujours masqués", async (t) => {
  const { ws } = fixture(t);
  const { json } = await inSandbox(
    profile(ws),
    `${TRY} console.log(JSON.stringify({ env: tryRead('/workspace/.env'), npmrc: tryRead('/workspace/.npmrc'), ssh: tryRead('/workspace/.ssh/id_ed25519') }))`,
  );
  assert.equal(json.env, "READ:FIXTURE_ENV=visible-by-default", "décision D-4 du propriétaire");
  assert.ok(!String(json.npmrc).includes("FIXTURE_NPM_TOKEN"));
  assert.ok(!String(json.ssh).includes("FIXTURE_SSH"));
});

sb("D-4 : protection activée -> .env et .env.local illisibles (ni lecture ni cat), fichier hôte intact", async (t) => {
  const { ws } = fixture(t);
  const { json } = await inSandbox(
    profile(ws, { protectEnvFiles: true }),
    `${TRY} const cp=require('child_process');
     const cat=cp.spawnSync('/usr/bin/cat',['/workspace/.env'],{encoding:'utf8'});
     console.log(JSON.stringify({ env: tryRead('/workspace/.env'), local: tryRead('/workspace/config/.env.local'),
       write: tryWrite('/workspace/.env'), cat: cat.stdout + cat.stderr }))`,
  );
  for (const v of [json.env, json.local]) assert.ok(!String(v).includes("FIXTURE"), `fuite: ${v}`);
  assert.notEqual(json.write, "WROTE");
  assert.ok(!json.cat.includes("FIXTURE_ENV"), "cat ne lit pas le contenu (UC-09)");
  assert.match(readFileSync(join(ws, ".env"), "utf8"), /FIXTURE_ENV/);
});

sb("seccomp : actif (mode 2) ; unshare, mount et création de user namespace refusés", async (t) => {
  const { ws } = fixture(t);
  const { json } = await inSandbox(
    profile(ws),
    `const cp=require('child_process');const fs=require('fs');
     const s=fs.readFileSync('/proc/self/status','utf8');
     const u=cp.spawnSync('/usr/bin/unshare',['-U','/usr/bin/true'],{encoding:'utf8'});
     const m=cp.spawnSync('/usr/bin/mount',['-t','tmpfs','none','/tmp'],{encoding:'utf8'});
     console.log(JSON.stringify({ seccomp: s.match(/Seccomp:\\s*(\\d)/)[1], unshare: u.status, unshareErr: u.stderr, mount: m.status, caps: s.match(/CapEff:\\s*(\\S+)/)[1], nnp: s.match(/NoNewPrivs:\\s*(\\d)/)[1] }))`,
  );
  assert.equal(json.seccomp, "2", "filtre seccomp chargé");
  assert.notEqual(json.unshare, 0);
  assert.match(json.unshareErr, /Operation not permitted/);
  assert.notEqual(json.mount, 0);
  assert.equal(json.caps, "0000000000000000");
  assert.equal(json.nnp, "1");
});

sb("réseau par défaut refusé : TCP externe et service local de l'hôte inatteignables", async (t) => {
  const { ws } = fixture(t);
  const server = createServer((s) => s.end("HOST")).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const { json } = await inSandbox(
    profile(ws),
    `const net=require('net');const probe=(h,p)=>new Promise(r=>net.connect(p,h).on('connect',()=>r('CONNECTED')).on('error',e=>r(e.code)));
     (async()=>console.log(JSON.stringify({ ext: await probe('192.0.2.1',443), host: await probe('127.0.0.1',${port}) })))()`,
  );
  assert.deepEqual(json, { ext: "ENETUNREACH", host: "ECONNREFUSED" });
});

sb("cgroups : limite de tâches (fork bornée) et de mémoire appliquées", async (t) => {
  if (!caps.cgroups) return t.skip(`cgroups indisponibles : ${caps.reasons.join("; ")}`);
  const { ws } = fixture(t);
  const forks = await inSandbox(
    profile(ws, { limits: { tasksMax: 24 } }),
    `const cp=require('child_process');let ok=0,ko=0;for(let i=0;i<60;i++){try{const c=cp.spawn('/usr/bin/sleep',['2']);c.on('error',()=>{});if(c.pid)ok++;else ko++}catch{ko++}}
     console.log(JSON.stringify({ok,ko}));process.exit(0)`,
  );
  assert.ok(forks.json.ok < 60, `toutes les créations ont réussi malgré TasksMax : ${JSON.stringify(forks.json)}`);
  const mem = await inSandbox(
    profile(ws, { limits: { memoryMaxBytes: 96 * 1024 * 1024 } }),
    `const a=[];for(let i=0;i<64;i++){a.push(Buffer.alloc(16*1024*1024,1))}console.log('"survived"')`,
  );
  assert.notEqual(mem.json, "survived", "l'allocation de 1 Gio aurait dû être tuée par MemoryMax");
  assert.notEqual(mem.r.exitCode, 0);
});

sb("annulation : un descendant setsid lancé dans le sandbox ne survit pas", async (t) => {
  const { ws } = fixture(t);
  const ac = new AbortController();
  const beat = `process.on('SIGTERM',()=>{});let n=0;setInterval(()=>require('fs').writeFileSync('/workspace/hb',String(++n)),50);setTimeout(()=>process.exit(0),8000)`;
  const p = inSandbox(
    profile(ws),
    `require('child_process').spawn('/usr/bin/setsid',['${NODE}','-e',${JSON.stringify(beat)}],{stdio:'ignore'});setInterval(()=>{},1e3)`,
    { signal: ac.signal },
  );
  const hb = join(ws, "hb");
  const read = () => (existsSync(hb) ? readFileSync(hb, "utf8") : null);
  const end = Date.now() + 8000;
  while (read() === null && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.notEqual(read(), null);
  const t0 = Date.now();
  ac.abort();
  const { r } = await p;
  assert.equal(r.cancelled, true);
  assert.ok(Date.now() - t0 < 3000, "NFR-005");
  const a = read();
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(read(), a, "le descendant setsid a survécu");
});

sb(
  "egress AC-07 : destination allowlistée via le proxy ; non allowlistée, IP littérale et adresse privée refusées et journalisées",
  async (t) => {
    const { root, ws } = fixture(t);
    const upstream = createServer((s) => s.end("UPSTREAM_OK")).listen(0, "127.0.0.1");
    await new Promise((r) => upstream.once("listening", r));
    t.after(() => upstream.close());
    const upPort = (upstream.address() as { port: number }).port;
    mkdirSync(join(root, "sock"), { mode: 0o700 });
    const proxy = await startEgressProxy({
      socketPath: join(root, "sock", "egress.sock"),
      allow: [`api.allowed.test:${upPort}`, `rebind.test:${upPort}`],
      resolve: async (h) => (h === "api.allowed.test" ? ["127.0.0.1"] : ["10.1.2.3"]),
      allowLoopbackForTests: true,
    });
    t.after(() => proxy.close());
    const p = profile(ws, {
      network: { mode: "proxy", allow: [`api.allowed.test:${upPort}`] },
      readOnlyBinds: [
        [process.execPath, NODE],
        [proxyBridgePath(), "/opt/nexus/proxy-bridge.mjs"],
      ],
    });
    const script = `(async()=>{const { startBridge } = await import('/opt/nexus/proxy-bridge.mjs');const net=require('net');
    const port=await startBridge(process.env.NEXUS_EGRESS_SOCKET);
    const ask=t=>new Promise(r=>{const s=net.connect(port,'127.0.0.1',()=>s.write('CONNECT '+t+' HTTP/1.1\\r\\n\\r\\n'));let b='';s.on('data',d=>b+=d).on('end',()=>r(b.split('\\r\\n')[0]+(b.includes('UPSTREAM_OK')?' +data':''))).on('error',e=>r(e.code))});
    const direct=await new Promise(r=>net.connect(443,'1.1.1.1').on('error',e=>r(e.code)).on('connect',()=>r('CONNECTED')));
    console.log(JSON.stringify({ direct, ok: await ask('api.allowed.test:${upPort}'), denied: await ask('exfil.test:443'), literal: await ask('10.0.0.1:${upPort}'), rebind: await ask('rebind.test:${upPort}') }));process.exit(0)})()`;
    const { json } = await inSandbox(p, script, { egressSocketPath: proxy.socketPath });
    assert.equal(json.direct, "ENETUNREACH");
    assert.equal(json.ok, "HTTP/1.1 200 Connection Established +data");
    assert.match(json.denied, /^HTTP\/1\.1 403/);
    assert.match(json.literal, /^HTTP\/1\.1 403/);
    assert.match(json.rebind, /^HTTP\/1\.1 403/, "nom autorisé résolu vers une adresse privée : refusé");
    assert.deepEqual(
      proxy.audit.map((a) => [a.target?.split(":")[0], a.decision, a.reason ?? ""]),
      [
        ["api.allowed.test", "allow", ""],
        ["exfil.test", "deny", "not_in_allowlist"],
        ["10.0.0.1", "deny", "not_in_allowlist"],
        ["rebind.test", "deny", "forbidden_address"],
      ],
    );
  },
);

const hostGit = (cwd: string, ...args: string[]) =>
  execFileSync("/usr/bin/git", args, {
    cwd,
    env: { HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", LANG: "C", PATH: "/usr/bin:/bin" },
    encoding: "utf8",
  });
function gitRepo(dir: string) {
  hostGit(dir, "init", "--quiet", "-b", "main");
  hostGit(dir, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "--quiet", "--allow-empty", "-m", "i");
}

sb("git : .git du workspace en lecture seule (config, hooks, renommage) ; git lisible dans le sandbox", async (t) => {
  const { ws } = fixture(t);
  gitRepo(ws);
  const before = readFileSync(join(ws, ".git", "config"), "utf8");
  const { json } = await inSandbox(
    profile(ws),
    `${TRY} const cp=require('child_process');
     const git=(...a)=>{try{return cp.execFileSync('/usr/bin/git',a,{cwd:'/workspace',encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()}catch(e){return 'ERR:'+e.status}};
     const tryRename=()=>{try{fs.renameSync('/workspace/.git','/workspace/g2');return 'RENAMED'}catch(e){return e.code}};
     const tryRm=()=>{try{fs.rmSync('/workspace/.git',{recursive:true});return 'REMOVED'}catch(e){return e.code}};
     console.log(JSON.stringify({ config: tryWrite('/workspace/.git/config'), hook: tryWrite('/workspace/.git/hooks/pre-commit'),
       head: tryRead('/workspace/.git/HEAD'), rename: tryRename(), rm: tryRm(), file: tryWrite('/workspace/f.txt'),
       log: git('log','--format=%s'), status: git('status','--porcelain') }))`,
  );
  assert.equal(json.config, "EROFS");
  assert.equal(json.hook, "EROFS");
  assert.equal(json.head, "READ:ref: refs/heads/main");
  assert.ok(["EBUSY", "EROFS", "EXDEV"].includes(json.rename), json.rename);
  assert.notEqual(json.rm, "REMOVED");
  assert.equal(json.file, "WROTE", "le reste du workspace reste inscriptible");
  assert.equal(json.log, "i", "git lisible dans le sandbox");
  assert.ok(String(json.status).includes("f.txt"), String(json.status));
  assert.equal(readFileSync(join(ws, ".git", "config"), "utf8"), before);
  assert.ok(existsSync(join(ws, ".git", "HEAD")));
});

sb("git : pointeur .git d'un worktree, gitdir et commondir en lecture seule s'ils sont montés", async (t) => {
  const { root } = fixture(t);
  const main = join(root, "main");
  const wt = join(root, "wt");
  mkdirSync(main);
  gitRepo(main);
  hostGit(main, "worktree", "add", "--quiet", "-b", "task", wt);
  const meta = gitMetadataPaths(wt);
  assert.deepEqual(meta.sort(), [join(main, ".git"), join(main, ".git", "worktrees", "wt"), join(wt, ".git")].sort());
  // Dépôt principal monté en écriture (ex. extraWritable) : ses métadonnées sont recouvertes en lecture seule.
  const p = profile(wt, { writableBinds: [[main, main]] });
  assert.deepEqual(
    buildBwrapArgs(p).gitReadOnly.sort(),
    ["/workspace/.git", join(main, ".git"), join(main, ".git", "worktrees", "wt")].sort(),
  );
  const pointer = readFileSync(join(wt, ".git"), "utf8");
  const { json } = await inSandbox(
    p,
    `${TRY} console.log(JSON.stringify({ pointer: tryWrite('/workspace/.git'),
       cfg: tryWrite(${JSON.stringify(join(main, ".git", "config"))}),
       wtcfg: tryWrite(${JSON.stringify(join(main, ".git", "worktrees", "wt", "config.worktree"))}),
       mainFile: tryWrite(${JSON.stringify(join(main, "x.txt"))}) }))`,
  );
  assert.deepEqual([json.pointer, json.cfg, json.wtcfg], ["EROFS", "EROFS", "EROFS"]);
  assert.equal(json.mainFile, "WROTE");
  assert.equal(readFileSync(join(wt, ".git"), "utf8"), pointer);
});

test("capacités insuffisantes : exécution refusée (sandbox_unavailable), jamais simulée", async (t) => {
  const { ws } = fixture(t);
  const none: SandboxCapabilities = {
    platform: "linux",
    bwrap: false,
    pidNamespace: true,
    seccomp: true,
    cgroups: false,
    reasons: ["test"],
  };
  const r = await createSandboxedRunner(profile(ws), none)({ file: NODE, args: [], cwd: ws, env: {}, timeoutMs: 1000 });
  assert.equal(r.spawnError, "sandbox_unavailable");
  const noCg: SandboxCapabilities = { ...none, bwrap: true };
  const r2 = await createSandboxedRunner(
    profile(ws, { limits: { tasksMax: 8 } }),
    noCg,
  )({ file: NODE, args: [], cwd: ws, env: {}, timeoutMs: 1000 });
  assert.equal(r2.spawnError, "sandbox_unavailable", "limites demandées mais inapplicables : refus");
});

test("adresses interdites : privées, bouclage, link-local, CGNAT, multicast, IPv6 locales et mappées", () => {
  for (const a of [
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "nope",
  ]) {
    assert.equal(isForbiddenAddress(a), true, a);
  }
  for (const a of ["1.1.1.1", "140.82.112.3", "2606:4700::1111"]) assert.equal(isForbiddenAddress(a), false, a);
});
