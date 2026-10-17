// Configuration de Monaco compatible avec la CSP stricte (`script-src 'self'`, pas d'eval) :
// - le worker de l'éditeur est importé via `?worker` : Vite l'émet comme fichier distinct de même origine
//   (aucun blob:, aucun data:) ;
// - on reprend les contributions de `editor.main` SANS les services de langage lourds (TypeScript, JSON, CSS, HTML
//   et leurs workers) ni le client LSP : seule la coloration syntaxique (Monarch, sans worker) est embarquée,
//   pour une liste courte de langages utiles. Chaque langage est chargé à la demande (import dynamique).
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import * as monaco from "monaco-editor/editor/editor.api.js";

import "monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/caretOperations/browser/transpose.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/codeAction/browser/codeActionContributions.js";
import "monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js";
import "monaco-editor/editor/contrib/codelens/browser/codelensController.js";
import "monaco-editor/editor/contrib/colorPicker/browser/colorPickerContribution.js";
import "monaco-editor/editor/contrib/comment/browser/comment.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js";
import "monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js";
import "monaco-editor/editor/contrib/diffEditorBreadcrumbs/browser/contribution.js";
import "monaco-editor/editor/contrib/dnd/browser/dnd.js";
import "monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols.js";
import "monaco-editor/editor/contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js";
import "monaco-editor/features/find/register.js";
import "monaco-editor/editor/contrib/floatingMenu/browser/floatingMenu.contribution.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/fontZoom/browser/fontZoom.js";
import "monaco-editor/editor/contrib/format/browser/formatActions.js";
import "monaco-editor/editor/contrib/gotoError/browser/gotoError.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js";
import "monaco-editor/editor/contrib/gpu/browser/gpuActions.js";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/editor/contrib/indentation/browser/indentation.js";
import "monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution.js";
import "monaco-editor/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.js";
import "monaco-editor/editor/contrib/inlineProgress/browser/inlineProgress.js";
import "monaco-editor/editor/contrib/inPlaceReplace/browser/inPlaceReplace.js";
import "monaco-editor/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine.js";
import "monaco-editor/editor/standalone/browser/inspectTokens/inspectTokens.js";
import "monaco-editor/editor/standalone/browser/iPadShowKeyboard/iPadShowKeyboard.js";
import "monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/linkedEditing/browser/linkedEditing.js";
import "monaco-editor/editor/contrib/links/browser/links.js";
import "monaco-editor/editor/contrib/longLinesHelper/browser/longLinesHelper.js";
import "monaco-editor/editor/contrib/middleScroll/browser/middleScroll.contribution.js";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js";
import "monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js";
import "monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js";
import "monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js";
import "monaco-editor/editor/contrib/rename/browser/rename.js";
import "monaco-editor/editor/contrib/sectionHeaders/browser/sectionHeaders.js";
import "monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js";
import "monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2.js";
import "monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestInlineCompletions.js";
import "monaco-editor/editor/standalone/browser/toggleHighContrast/toggleHighContrast.js";
import "monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js";
import "monaco-editor/editor/contrib/tokenization/browser/tokenization.js";
import "monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js";
import "monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js";
import "monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js";
import "monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js";
import "monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/editor/common/standaloneStrings.js";

// Langages (coloration seulement).
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/scss/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
import "monaco-editor/languages/definitions/dockerfile/register.js";
import "monaco-editor/languages/definitions/sql/register.js";
import "monaco-editor/languages/definitions/rust/register.js";
import "monaco-editor/languages/definitions/go/register.js";
import "monaco-editor/languages/definitions/xml/register.js";
import "monaco-editor/languages/definitions/ini/register.js";

(globalThis as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  // Un seul worker (éditeur) : les autres langages n'en ont pas besoin.
  getWorker: () => new EditorWorker(),
};

/** Langage Monaco pour un chemin, d'après les extensions enregistrées ; JSON coloré comme JavaScript. */
export function languageFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "javascript";
  const base = lower.split("/").pop() ?? lower;
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === base)) return lang.id;
    if (lang.extensions?.some((ext) => lower.endsWith(ext.toLowerCase()))) return lang.id;
  }
  return "plaintext";
}

export { monaco };

// Thèmes de l'éditeur générés à partir des jetons CSS du thème courant (Monaco n'accepte que des couleurs
// littérales : on lit les jetons au moment d'appliquer le thème et on les convertit en hexadécimal).
let probe: HTMLSpanElement | undefined;

/** Couleur CSS quelconque (jeton, rgba, color-mix…) → « rrggbb » ou « rrggbbaa », via le moteur de rendu. */
function cssToHex(value: string): string | undefined {
  if (!value || typeof document === "undefined") return undefined;
  probe ??= Object.assign(document.createElement("span"), { hidden: true });
  if (!probe.isConnected) document.body.appendChild(probe);
  probe.style.color = "";
  probe.style.color = value;
  const m = getComputedStyle(probe).color.match(/rgba?\(([^)]+)\)/);
  if (!m?.[1]) return undefined;
  const [r = 0, g = 0, b = 0, a = 1] = m[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  const hex = (n: number) =>
    Math.round(Math.max(0, Math.min(255, n)))
      .toString(16)
      .padStart(2, "0");
  return `${hex(r)}${hex(g)}${hex(b)}${a < 1 ? hex(a * 255) : ""}`;
}

function token(name: string, alpha?: number): string | undefined {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!v) return undefined;
  return cssToHex(alpha === undefined ? v : `color-mix(in srgb, ${v} ${Math.round(alpha * 100)}%, transparent)`);
}

function defineThemeFromTokens(name: string, base: "vs" | "vs-dark"): void {
  const c = (n: string, alpha?: number) => {
    const h = token(n, alpha);
    return h ? `#${h}` : undefined;
  };
  const colors: Record<string, string | undefined> = {
    focusBorder: c("--focus-ring"),
    foreground: c("--fg"),
    "editor.background": c("--surface"),
    "editor.foreground": c("--fg"),
    "editor.lineHighlightBackground": c("--hover"),
    "editor.lineHighlightBorder": c("--hover"),
    "editorLineNumber.foreground": c("--fg-subtle"),
    "editorLineNumber.activeForeground": c("--fg"),
    "editorGutter.background": c("--surface"),
    "editor.selectionBackground": c("--selection"),
    "editor.inactiveSelectionBackground": c("--accent", 0.14),
    "editor.selectionHighlightBackground": c("--accent", 0.16),
    "editor.wordHighlightBackground": c("--accent", 0.14),
    "editor.wordHighlightStrongBackground": c("--accent", 0.22),
    "editor.findMatchBackground": c("--warning", 0.4),
    "editor.findMatchHighlightBackground": c("--warning", 0.2),
    "editor.findRangeHighlightBackground": c("--accent", 0.08),
    "editor.hoverHighlightBackground": c("--accent", 0.1),
    "editorCursor.foreground": c("--accent-text"),
    "editorWhitespace.foreground": c("--border-strong"),
    "editorIndentGuide.background1": c("--border"),
    "editorIndentGuide.activeBackground1": c("--border-strong"),
    "editorRuler.foreground": c("--border"),
    "editorBracketHighlight.foreground1": c("--ic-yellow"),
    "editorBracketHighlight.foreground2": c("--ic-purple"),
    "editorBracketHighlight.foreground3": c("--ic-blue"),
    "editorBracketHighlight.unexpectedBracket.foreground": c("--danger"),
    "editorBracketMatch.background": c("--accent", 0.12),
    "editorBracketMatch.border": c("--accent", 0.5),
    "editorLink.activeForeground": c("--accent-text"),
    "editorError.foreground": c("--danger"),
    "editorWarning.foreground": c("--warning"),
    "editorInfo.foreground": c("--info"),
    "editorOverviewRuler.border": c("--border"),
    "editorStickyScroll.background": c("--surface"),
    "editorStickyScrollHover.background": c("--hover"),
    "editorWidget.background": c("--elevated"),
    "editorWidget.foreground": c("--fg"),
    "editorWidget.border": c("--border-strong"),
    "editorHoverWidget.background": c("--elevated"),
    "editorHoverWidget.border": c("--border-strong"),
    "editorSuggestWidget.background": c("--elevated"),
    "editorSuggestWidget.border": c("--border-strong"),
    "editorSuggestWidget.foreground": c("--fg"),
    "editorSuggestWidget.selectedBackground": c("--accent-soft"),
    "editorSuggestWidget.highlightForeground": c("--accent-text"),
    "editorSuggestWidget.focusHighlightForeground": c("--accent-text"),
    "widget.shadow": c("--overlay-bg"),
    "input.background": c("--surface"),
    "input.foreground": c("--fg"),
    "input.border": c("--border-strong"),
    "input.placeholderForeground": c("--fg-subtle"),
    "inputOption.activeBorder": c("--accent"),
    "inputOption.activeBackground": c("--accent-soft"),
    "list.hoverBackground": c("--hover"),
    "list.activeSelectionBackground": c("--accent-soft"),
    "list.activeSelectionForeground": c("--fg"),
    "list.focusBackground": c("--accent-soft"),
    "list.highlightForeground": c("--accent-text"),
    "quickInput.background": c("--elevated"),
    "quickInput.foreground": c("--fg"),
    "menu.background": c("--elevated"),
    "menu.foreground": c("--fg"),
    "menu.selectionBackground": c("--accent"),
    "menu.selectionForeground": c("--accent-fg"),
    "menu.separatorBackground": c("--border"),
    "minimap.background": c("--surface"),
    "scrollbar.shadow": c("--overlay-bg"),
    "scrollbarSlider.background": c("--scrollbar-thumb"),
    "scrollbarSlider.hoverBackground": c("--scrollbar-thumb-hover"),
    "scrollbarSlider.activeBackground": c("--scrollbar-thumb-active"),
    // Éditeur de diff : fond des lignes, surlignage des mots, gouttière et règle.
    "diffEditor.insertedLineBackground": c("--diff-add-line"),
    "diffEditor.removedLineBackground": c("--diff-del-line"),
    "diffEditor.insertedTextBackground": c("--diff-add-word"),
    "diffEditor.removedTextBackground": c("--diff-del-word"),
    "diffEditorGutter.insertedLineBackground": c("--diff-add-gutter"),
    "diffEditorGutter.removedLineBackground": c("--diff-del-gutter"),
    "diffEditorOverview.insertedForeground": c("--success", 0.6),
    "diffEditorOverview.removedForeground": c("--danger", 0.6),
    "diffEditor.diagonalFill": c("--border"),
    "diffEditor.unchangedRegionBackground": c("--surface-2"),
    "diffEditor.unchangedRegionForeground": c("--fg-muted"),
    "diffEditor.border": c("--border"),
  };
  const rule = (tokenName: string, cssVar: string, fontStyle?: string) => {
    const h = token(cssVar);
    return h ? [{ token: tokenName, foreground: h.slice(0, 6), ...(fontStyle && { fontStyle }) }] : [];
  };
  monaco.editor.defineTheme(name, {
    base,
    inherit: true,
    rules: [
      ...rule("", "--fg"),
      ...rule("comment", "--fg-subtle", "italic"),
      ...rule("keyword", "--ic-purple"),
      ...rule("string", "--ic-green"),
      ...rule("string.escape", "--ic-orange"),
      ...rule("regexp", "--ic-pink"),
      ...rule("number", "--ic-orange"),
      ...rule("constant", "--ic-orange"),
      ...rule("type", "--ic-blue"),
      ...rule("tag", "--ic-blue"),
      ...rule("metatag", "--ic-pink"),
      ...rule("annotation", "--ic-yellow"),
      ...rule("attribute.name", "--ic-cyan"),
      ...rule("attribute.value", "--ic-green"),
      ...rule("variable.predefined", "--ic-cyan"),
      ...rule("predefined", "--ic-cyan"),
      ...rule("delimiter", "--fg-muted"),
      ...rule("operator", "--fg-muted"),
      ...rule("key", "--ic-blue"),
      ...rule("emphasis", "--fg", "italic"),
      ...rule("strong", "--fg", "bold"),
      ...rule("invalid", "--danger"),
    ],
    colors: Object.fromEntries(Object.entries(colors).filter((e): e is [string, string] => Boolean(e[1]))),
  });
}

export function applyMonacoTheme(theme: "dark" | "light"): void {
  const name = theme === "dark" ? "nexus-dark" : "nexus-light";
  // Les jetons dépendent de data-theme (déjà posé par le store) : thème régénéré à chaque changement.
  defineThemeFromTokens(name, theme === "dark" ? "vs-dark" : "vs");
  monaco.editor.setTheme(name);
}
