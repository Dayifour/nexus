// Projet ouvert et projets récents. Ouvrir un dossier = `projects.open` (le main crée le projet s'il n'existe pas).
// Tant que ce canal n'est pas servi, repli honnête : projet existant pour ce chemin, sinon `projects.create`.
import { create } from "zustand";
import { call, isUnavailable } from "../api.ts";
import type { ProjectSummary, RecentProject, Res } from "../types.ts";
import { useEditorsStore } from "./editors.ts";
import { useFilesStore } from "./files.ts";
import { useGitStore } from "./git.ts";
import { useSessionsStore } from "./sessions.ts";
import { useRunsStore } from "./runs.ts";
import { useOrchestraStore } from "./orchestra.ts";
import { done, failed, pending } from "./util.ts";

/** Remise à zéro synchrone des états liés au projet, AVANT le montage du plan de travail du nouveau projet. */
function resetProjectStores(projectId: string | undefined): void {
  useFilesStore.getState().reset(projectId);
  useEditorsStore.getState().reset(projectId);
  useGitStore.getState().reset(projectId);
  useSessionsStore.getState().reset(projectId);
  useOrchestraStore.getState().reset(projectId);
  useRunsStore.getState().evictRuns();
}

/**
 * Garde avant de quitter le projet courant (fermeture, changement) : renvoie faux pour annuler. Posée par l'interface
 * (question sur les éditeurs modifiés) ; le store n'importe pas l'interface.
 */
type LeaveGuard = (action: "close" | "switch") => Promise<boolean>;
let leaveGuard: LeaveGuard = async () => true;
export function setProjectLeaveGuard(guard: LeaveGuard): void {
  leaveGuard = guard;
}

interface ProjectState {
  current?: ProjectSummary;
  recent: Res<RecentProject[]>;
  opening: boolean;
  loadRecent(): Promise<void>;
  /** Ouvre le dossier `rootPath` (absolu) ; lève une NexusError en cas de refus. */
  openPath(rootPath: string): Promise<ProjectSummary>;
  /** Ouvre `project` ; faux si l'utilisateur a annulé (modifications non enregistrées du projet courant). */
  openProject(project: ProjectSummary): Promise<boolean>;
  importArchive(): Promise<ProjectSummary | undefined>;
  /** Ferme le projet ; faux si l'utilisateur a annulé (modifications non enregistrées). */
  close(): Promise<boolean>;
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);

export function baseName(path: string): string {
  const parts = trimSlash(path).split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export const useProjectStore = create<ProjectState>()((set, get) => ({
  current: undefined,
  recent: { loading: false },
  opening: false,
  async loadRecent() {
    set((s) => ({ recent: pending(s.recent) }));
    try {
      set({ recent: done(await call("projects.recent", {})) });
    } catch (e) {
      if (!isUnavailable(e)) {
        set((s) => ({ recent: failed(s.recent, e) }));
        return;
      }
      try {
        const list = await call("projects.list", {});
        set({ recent: done([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) });
      } catch (e2) {
        set((s) => ({ recent: failed(s.recent, e2) }));
      }
    }
  },
  async openPath(rootPath) {
    const path = trimSlash(rootPath.trim());
    set({ opening: true });
    try {
      let project: ProjectSummary;
      try {
        project = await call("projects.open", { rootPath: path });
      } catch (e) {
        if (!isUnavailable(e)) throw e;
        const existing = (await call("projects.list", {})).find((p) => trimSlash(p.rootPath) === path);
        project =
          existing ??
          (await call("projects.create", { name: baseName(path).slice(0, 200) || "project", rootPath: path }));
      }
      await get().openProject(project);
      return project;
    } finally {
      set({ opening: false });
    }
  },
  async openProject(project) {
    const current = get().current;
    if (current?.projectId !== project.projectId) {
      if (current && !(await leaveGuard("switch"))) return false;
      resetProjectStores(project.projectId);
    }
    set({ current: project });
    document.title = `${project.name} — Nexus AI`;
    return true;
  },
  async importArchive() {
    const { projectId } = await call("projects.import", {});
    if (!projectId) return undefined;
    const project = (await call("projects.list", {})).find((p) => p.projectId === projectId);
    if (project) await get().openProject(project);
    return project;
  },
  async close() {
    if (get().current && !(await leaveGuard("close"))) return false;
    set({ current: undefined });
    resetProjectStores(undefined);
    document.title = "Nexus AI";
    void get().loadRecent();
    return true;
  },
}));
