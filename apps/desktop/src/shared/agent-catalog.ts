// Agents CLI pris en charge : commande d'installation officielle, connexion, documentation. Partagé par le renderer
// (accueil « aucun agent détecté ») et le main (seules ces pages de documentation peuvent s'ouvrir dans le
// navigateur du système : liste fermée, jamais une URL fournie par le renderer).

export interface AgentCatalogEntry {
  connectorId: string;
  name: string;
  /** Commande d'installation officielle (documentation de l'éditeur). */
  install: string;
  /** Commande à lancer une fois dans un terminal pour se connecter. */
  login: string;
  docsUrl: string;
}

export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  {
    connectorId: "claude-cli",
    name: "Claude Code",
    install: "npm install -g @anthropic-ai/claude-code",
    login: "claude",
    docsUrl: "https://docs.claude.com/en/docs/claude-code/setup",
  },
  {
    connectorId: "codex-cli",
    name: "Codex CLI",
    install: "npm install -g @openai/codex",
    login: "codex login",
    docsUrl: "https://github.com/openai/codex",
  },
  {
    connectorId: "gemini-cli",
    name: "Gemini CLI",
    install: "npm install -g @google/gemini-cli",
    login: "gemini",
    docsUrl: "https://github.com/google-gemini/gemini-cli",
  },
  {
    connectorId: "qwen-cli",
    name: "Qwen Code",
    install: "npm install -g @qwen-code/qwen-code",
    login: "qwen",
    docsUrl: "https://github.com/QwenLM/qwen-code",
  },
  {
    connectorId: "opencode-cli",
    name: "OpenCode",
    install: "npm install -g opencode-ai",
    login: "opencode auth login",
    docsUrl: "https://opencode.ai/docs",
  },
  {
    connectorId: "hermes-cli",
    name: "Hermes",
    install: "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash",
    login: "hermes setup",
    docsUrl: "https://github.com/NousResearch/hermes-agent",
  },
];

/** Vrai pour une page de documentation du catalogue (comparaison exacte, https uniquement). */
export function isCatalogDocsUrl(url: string): boolean {
  return AGENT_CATALOG.some((a) => a.docsUrl === url) && url.startsWith("https://");
}
