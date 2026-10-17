// Garde des modifications non enregistrées : avant de fermer le projet, d'en ouvrir un autre ou de fermer la
// fenêtre, les éditeurs modifiés font l'objet d'une seule question (Tout enregistrer / Ne pas enregistrer / Annuler),
// comme la fermeture d'un onglet modifié.
//
// Fermeture de la fenêtre : la fenêtre Electron émet `close` puis l'événement DOM `beforeunload` du renderer. Annuler
// `beforeunload` annule la fermeture (et `app.quit()`) ; le renderer pose alors sa question et referme lui-même la
// fenêtre si l'utilisateur le décide. Un renderer planté ne bloque jamais la fermeture (pas d'aller-retour IPC).
import { toast } from "sonner";
import { tNow } from "../i18n/index.ts";
import { isUntitledKey, useEditorsStore } from "../stores/editors.ts";
import { ask } from "../ui/dialog.tsx";
import { getDock } from "../workbench/dock.ts";
import { errorText, saveUntitled } from "./actions.ts";

/** Documents modifiés (fichiers et documents sans titre non vides). */
export function dirtyDocs(): string[] {
  return Object.entries(useEditorsStore.getState().docs)
    .filter(([, d]) => d.dirty)
    .map(([path]) => path);
}

function displayName(path: string): string {
  if (isUntitledKey(path)) return getDock()?.getPanel(`editor:${path}`)?.title ?? tNow("editor.untitled");
  return path.split("/").pop() ?? path;
}

let pending: Promise<boolean> | undefined;

/**
 * Vrai si l'on peut continuer (rien de modifié, tout enregistré, ou modifications abandonnées) ; faux si
 * l'utilisateur annule ou si un enregistrement échoue. Une seule question à la fois.
 */
export function resolveUnsaved(action: "close" | "switch" | "quit"): Promise<boolean> {
  if (pending) return pending;
  const dirty = dirtyDocs();
  if (dirty.length === 0) return Promise.resolve(true);
  pending = (async () => {
    const names = dirty.slice(0, 6).map(displayName).join(", ") + (dirty.length > 6 ? "…" : "");
    const choice = await ask({
      title:
        dirty.length === 1
          ? tNow("unsaved.titleOne", { name: displayName(dirty[0] ?? "") })
          : tNow("unsaved.titleMany", { n: dirty.length }),
      body: `${tNow(`unsaved.body.${action}`)} ${dirty.length > 1 ? names : ""}`.trim(),
      choices: [
        { id: "save", label: tNow(dirty.length === 1 ? "common.save" : "unsaved.saveAll"), variant: "primary" },
        { id: "discard", label: tNow("editor.dontSave"), variant: "danger" },
        { id: "cancel", label: tNow("common.cancel"), variant: "ghost" },
      ],
    });
    if (choice === "discard") return true;
    if (choice !== "save") return false;
    const editors = useEditorsStore.getState();
    for (const path of dirty) {
      if (!useEditorsStore.getState().docs[path]?.dirty) continue;
      if (isUntitledKey(path)) {
        if (!(await saveUntitled(path))) return false;
        continue;
      }
      try {
        if (!(await editors.save(path))) return false;
      } catch (e) {
        toast.error(errorText(e));
        return false;
      }
    }
    return true;
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}

let allowUnload = false;

/** À appeler avant un rechargement volontaire de la fenêtre (le contenu non enregistré est alors abandonné). */
export function allowWindowUnload(): void {
  allowUnload = true;
}

/** Intercepte la fermeture de la fenêtre tant que des éditeurs sont modifiés. */
export function installUnloadGuard(): () => void {
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (allowUnload || dirtyDocs().length === 0) return;
    e.preventDefault();
    // Electron annule la fermeture dès que `beforeunload` est annulé (aucune boîte native n'est affichée).
    e.returnValue = "unsaved";
    void resolveUnsaved("quit").then((ok) => {
      if (!ok) return;
      allowUnload = true;
      window.close();
    });
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  return () => window.removeEventListener("beforeunload", onBeforeUnload);
}
