// Visibilité d'un panneau dockview (onglet affiché ou non). Les panneaux toujours montés (sessions, orchestres)
// s'en servent pour geler leurs abonnements au flux tant qu'ils sont cachés : pas de rendu pour un onglet invisible,
// rattrapage immédiat quand il réapparaît.
import type { DockviewPanelApi } from "dockview";
import { useEffect, useRef, useState } from "react";

export function usePanelVisible(api: DockviewPanelApi): boolean {
  const [visible, setVisible] = useState(api.isVisible);
  useEffect(() => {
    setVisible(api.isVisible);
    const d = api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => d.dispose();
  }, [api]);
  return visible;
}

/**
 * Sélecteur gelé tant que `active` est faux : renvoie la dernière valeur vue pendant que le panneau était visible
 * (le store ne déclenche donc aucun rendu), puis la valeur courante dès qu'il redevient visible.
 */
export function useFrozenSelector<S, T>(active: boolean, select: (state: S) => T): (state: S) => T {
  const last = useRef<{ value: T } | undefined>(undefined);
  return (state: S) => {
    if (active || !last.current) last.current = { value: select(state) };
    return last.current.value;
  };
}
