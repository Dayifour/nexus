// Plan de déploiement côté services : persistance par projet, IA qui pilote (lecture seule), coffre, exécution des
// étapes avec confirmation native et journal en direct (expurgé).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DeploymentPlan, type AgentTaskRequest } from "@nexus/contracts";
import {
  analyzeProject,
  buildLeadPrompt,
  chosenProposal,
  DeployError,
  parseLeadAnswer,
  proposeDeployments,
  runStep,
  serviceName,
} from "@nexus/deploy-planner";
import { locateGit } from "@nexus/git";
import { runProcess } from "@nexus/process-supervisor";
import type { AppHandlers } from "./handlers.ts";
import { localizeMessage } from "./messages.ts";
import type { AppServices } from "./services.ts";

type Exposed = (
  code: "invalid_request" | "not_found" | "conflict" | "policy_denied" | "unavailable",
  message: string,
) => Error;
const PURPOSE = "deploy:plan";
const SECRET_REFS = ["deploy.vercel", "deploy.render", "deploy.railway", "deploy.atlas"];

export function createDeployHandlers(
  svc: AppServices,
  exposed: Exposed,
  guard: <T>(fn: () => Promise<T> | T) => Promise<T>,
): AppHandlers {
  const dir = join(svc.userDataDir, "deploy-plans");
  const file = (projectId: string) => join(dir, `${projectId}.json`);
  const running = new Set<string>();

  const load = (projectId: string): DeploymentPlan | null => {
    if (!existsSync(file(projectId))) return null;
    const r = DeploymentPlan.safeParse(JSON.parse(readFileSync(file(projectId), "utf8")));
    return r.success ? r.data : null;
  };
  const save = (plan: DeploymentPlan): DeploymentPlan => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file(plan.projectId)}.tmp`;
    writeFileSync(tmp, JSON.stringify(DeploymentPlan.parse(plan), null, 2), { mode: 0o600 });
    renameSync(tmp, file(plan.projectId));
    return plan;
  };
  const project = async (projectId: string) => {
    const p = await svc.core.store.prisma.project.findUnique({ where: { id: projectId } });
    if (!p) throw exposed("not_found", "Projet introuvable");
    return p;
  };
  const mustLoad = (projectId: string) => {
    const plan = load(projectId);
    if (!plan) throw exposed("not_found", "Analysez d'abord le projet");
    return plan;
  };
  const vault = () => {
    if (!svc.vault || !svc.broker) throw exposed("unavailable", "Coffre de secrets indisponible");
    return { vault: svc.vault, broker: svc.broker };
  };
  const gitRemote = async (root: string) => {
    const git = locateGit(svc.probeContext.pathEnv);
    if (!git) return undefined;
    let out = "";
    const r = await runProcess({
      file: git,
      args: ["-C", root, "remote", "get-url", "origin"],
      cwd: root,
      env: { PATH: svc.probeContext.pathEnv, HOME: svc.homeDir },
      timeoutMs: 10_000,
      onLine: (l, ch) => {
        if (ch === "stdout") out = l.trim();
      },
    });
    return r.exitCode === 0 && out ? out.slice(0, 500) : undefined;
  };
  const toExposed = (e: unknown): Error => {
    if (e instanceof DeployError) {
      const msg = svc.broker ? svc.broker.redact(e.message) : e.message;
      return exposed(
        e.code === "missing_input" ? "invalid_request" : e.code === "auth" ? "policy_denied" : "unavailable",
        msg,
      );
    }
    return e as Error;
  };

  return {
    "deployPlan.get": (req) => guard(() => load(req.projectId)),

    "deployPlan.analyze": (req) =>
      guard(async () => {
        const p = await project(req.projectId);
        const previous = load(req.projectId);
        const remote = await gitRemote(p.rootPath);
        const profile = { ...analyzeProject(p.rootPath), ...(remote && { gitRemote: remote }) };
        return save({
          projectId: p.id,
          createdAt: new Date().toISOString(),
          profile,
          proposals: proposeDeployments(profile),
          inputs: previous?.inputs ?? {},
          stepStatus: {},
        });
      }),

    "deployPlan.askLead": (req) =>
      guard(async () => {
        const plan = mustLoad(req.projectId);
        const p = await project(req.projectId);
        const connector = svc.registry.get(req.connectorId);
        if (!connector) throw exposed("not_found", `Agent ${req.connectorId} indisponible`);
        await svc.inventory();
        const rules = plan.proposals.filter((x) => x.origin === "rules");
        const task: AgentTaskRequest = {
          taskId: randomUUID(),
          projectId: p.id,
          sessionId: randomUUID(),
          agentProfileId: randomUUID(),
          workspacePath: p.rootPath,
          prompt: buildLeadPrompt(
            plan.profile,
            rules.length ? rules : plan.proposals,
            req.request,
            svc.settings.get().language,
          ),
          contextRefs: [],
          // Lecture seule : l'IA qui pilote conseille, elle ne touche à rien.
          permissionsPolicyId: "read-only",
          timeoutMs: 5 * 60_000,
        };
        let text = "";
        let failure: string | undefined;
        for await (const ev of connector.start(task, new AbortController().signal)) {
          if (ev.kind === "output" && ev.channel !== "stderr") text += `${ev.text}\n`;
          if (ev.kind === "failed") failure = ev.message;
        }
        if (!text.trim())
          throw exposed(
            "unavailable",
            failure ? `L'agent a échoué : ${failure.slice(0, 300)}` : "L'agent n'a rien répondu",
          );
        let answer: ReturnType<typeof parseLeadAnswer>;
        try {
          answer = parseLeadAnswer(text);
        } catch (e) {
          throw exposed("unavailable", (e as Error).message);
        }
        return save({
          ...plan,
          proposals: [...answer.proposals, ...rules].slice(0, 6),
          advice: answer.advice,
          chosenProposalId: undefined,
          stepStatus: {},
        });
      }),

    "deployPlan.choose": (req) =>
      guard(() => {
        const plan = mustLoad(req.projectId);
        if (req.proposalId && !plan.proposals.some((x) => x.id === req.proposalId))
          throw exposed("not_found", "Proposition inconnue");
        const { chosenProposalId: _c, ...rest } = plan;
        return save({ ...rest, ...(req.proposalId && { chosenProposalId: req.proposalId }), stepStatus: {} });
      }),

    "deployPlan.setInputs": (req) =>
      guard(() => {
        const plan = mustLoad(req.projectId);
        return save({ ...plan, inputs: { ...plan.inputs, ...req.inputs } });
      }),

    "deployPlan.setSecret": (req) =>
      guard(() => {
        mustLoad(req.projectId);
        vault().vault.set(req.ref, req.value, {
          label: `Déploiement : ${req.ref.replace(/^deploy\./, "")}`,
          purposes: [PURPOSE],
        });
        return { ok: true as const };
      }),

    "deployPlan.secretStatus": (req) =>
      guard(() => {
        const plan = mustLoad(req.projectId);
        const { vault: v } = vault();
        const envRefs = plan.profile.components.flatMap((c) =>
          c.envNames.map((n) => `deploy.env.${c.id.toLowerCase()}.${n.toLowerCase()}`),
        );
        return [...SECRET_REFS, ...envRefs, "deploy.out.database_uri"].filter((r) => v.has(r));
      }),

    "deployPlan.runStep": (req) =>
      guard(async () => {
        const plan = mustLoad(req.projectId);
        const p = await project(req.projectId);
        const proposal = chosenProposal(plan);
        const step = proposal.steps.find((s) => s.id === req.stepId);
        if (!step) throw exposed("not_found", "Étape inconnue");
        if (running.has(req.projectId)) throw exposed("conflict", "Une étape de déploiement est déjà en cours");
        // Action externe (création de service, déploiement) : confirmée par une boîte de dialogue native.
        if (svc.dialogs.confirm && !(await svc.dialogs.confirm(`Lancer « ${step.title} » ?`, step.detail))) {
          throw exposed("policy_denied", "Étape annulée");
        }
        const { vault: v, broker } = vault();
        const mark = (status: "running" | "done" | "failed", extra: { message?: string; url?: string } = {}) => {
          const cur = load(req.projectId) ?? plan;
          return save({
            ...cur,
            stepStatus: { ...cur.stepStatus, [step.id]: { status, ...extra, at: new Date().toISOString() } },
          });
        };
        running.add(req.projectId);
        mark("running");
        try {
          const out = await runStep(
            {
              fetch,
              secret: async (ref) => (v.has(ref) ? broker.withSecret(ref, PURPOSE, (x) => x) : undefined),
              setSecret: async (ref, value) =>
                void v.set(ref, value, { label: `Déploiement : ${ref.replace(/^deploy\./, "")}`, purposes: [PURPOSE] }),
              log: (line) =>
                svc.pushEvent({
                  type: "deploy-log",
                  projectId: p.id,
                  stepId: step.id,
                  line: localizeMessage(broker.redact(line), svc.settings.get().language).slice(0, 2000),
                }),
              projectName: serviceName(basename(p.rootPath)),
            },
            plan,
            step.id,
          );
          return mark("done", {
            message: localizeMessage(broker.redact(out.message), svc.settings.get().language),
            ...(out.url && { url: out.url }),
          });
        } catch (e) {
          const err = toExposed(e);
          mark("failed", { message: err.message.slice(0, 2000) });
          throw err;
        } finally {
          running.delete(req.projectId);
        }
      }),

    "deployPlan.markStep": (req) =>
      guard(() => {
        const plan = mustLoad(req.projectId);
        const { [req.stepId]: _old, ...others } = plan.stepStatus;
        return save({
          ...plan,
          stepStatus:
            req.status === "pending"
              ? others
              : { ...others, [req.stepId]: { status: req.status, at: new Date().toISOString() } },
        });
      }),
  };
}
