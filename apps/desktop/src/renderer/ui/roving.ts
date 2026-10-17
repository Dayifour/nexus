// Navigation clavier des groupes ARIA (WAI-ARIA Authoring Practices), appliquée à toute l'interface :
// - `role="radiogroup"` / `role="tablist"` : flèches (←/→/↑/↓), Origine et Fin déplacent le focus ET la sélection ;
// - « tabindex itinérant » : seul l'élément coché (ou le premier) est atteignable par Tab, les autres par les flèches.
// Une seule installation globale : les composants n'ont qu'à poser les rôles et aria-checked / aria-selected.
// Aucun MutationObserver : le tabindex d'un groupe est recalculé quand le focus y entre ou s'y déplace.

const GROUPS = '[role="radiogroup"], [role="tablist"]';
const ITEMS = '[role="radio"], [role="tab"]';

function itemsOf(group: Element): HTMLElement[] {
  return [...group.querySelectorAll<HTMLElement>(ITEMS)].filter(
    (el) =>
      el.closest(GROUPS) === group &&
      !(el as HTMLButtonElement).disabled &&
      el.getAttribute("aria-disabled") !== "true",
  );
}

const isChecked = (el: Element) =>
  el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true";

function syncGroup(group: Element): void {
  const all = [...group.querySelectorAll<HTMLElement>(ITEMS)].filter((el) => el.closest(GROUPS) === group);
  const enabled = itemsOf(group);
  const current = enabled.find(isChecked) ?? enabled[0];
  for (const el of all) {
    const want = el === current ? "0" : "-1";
    if (el.getAttribute("tabindex") !== want) el.setAttribute("tabindex", want);
  }
}

/** Groupes gérés par Radix (Tabs, RadioGroup…) : leur navigation clavier est déjà assurée, on n'y touche pas. */
const radixManaged = (el: Element) => el.hasAttribute("data-radix-collection-item");

function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const target = e.target as HTMLElement | null;
  const item = target?.closest?.<HTMLElement>(ITEMS);
  if (item && radixManaged(item)) return;
  const group = item?.closest(GROUPS);
  if (!item || !group) return;
  const items = itemsOf(group);
  const idx = items.indexOf(item);
  if (idx < 0) return;
  let next: HTMLElement | undefined;
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
      next = items[(idx + 1) % items.length];
      break;
    case "ArrowLeft":
    case "ArrowUp":
      next = items[(idx - 1 + items.length) % items.length];
      break;
    case "Home":
      next = items[0];
      break;
    case "End":
      next = items[items.length - 1];
      break;
    default:
      return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (!next || next === item) return;
  next.focus();
  // La sélection suit le focus (comportement standard des boutons radio et des onglets à activation automatique).
  next.click();
  requestAnimationFrame(() => syncGroup(group));
}

let installed = false;
/** Focus donné à la souris : l'élément cliqué garde le focus (pas de redirection vers l'élément coché). */
let pointerFocus = false;

/**
 * Tabindex itinérant posé à la demande, groupe par groupe, quand le focus y entre (et après chaque déplacement au
 * clavier) — sans observer tout le document : aucune surveillance du DOM pendant le flux des agents.
 */
function onFocusIn(e: FocusEvent): void {
  const target = e.target as HTMLElement | null;
  const item = target?.closest?.<HTMLElement>(ITEMS);
  const group = item?.closest(GROUPS);
  if (!item || !group || radixManaged(item)) return;
  syncGroup(group);
  const from = e.relatedTarget as Node | null;
  if (pointerFocus || (from && group.contains(from))) return;
  // Entrée au clavier (Tab / Maj+Tab) : le focus va à l'élément coché, comme le prévoit le motif ARIA.
  const current = itemsOf(group).find(isChecked);
  if (current && current !== item) current.focus();
}

const onPointerDown = () => {
  pointerFocus = true;
  setTimeout(() => {
    pointerFocus = false;
  }, 0);
};

/** Installe la navigation clavier et le tabindex itinérant pour tout le document (idempotent). */
export function installRovingFocus(): () => void {
  if (installed) return () => {};
  installed = true;
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("pointerdown", onPointerDown, true);
  return () => {
    installed = false;
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("pointerdown", onPointerDown, true);
  };
}
