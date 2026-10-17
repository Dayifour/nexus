# Concurrents Et Ressources

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

**Source :** chapitres 3, 27 de `SOURCES_ORIGINALES/Nexus_AI_SPEC_MASTER_v1.md`. Ce fichier est une extraction documentaire, sans remplacement du maître.

## Chapitre 3 — Analyse concurrentielle et règles de réutilisation

**Hydra** — dépôt : https://github.com/jpdlr/hydra. Documentation : desktop multi-sessions Claude Code/Codex, terminaux PTY, sessions reprises, superviseur MCP, statistiques d'usage, budgets. **Forces :** interface d'observation, reprise, orchestration opérationnelle. **Limites pour notre objectif :** angle CLI particulier, architecture spécifique à son produit, compatibilité API universelle à ne pas présumer. **À apprendre :** gestion des terminaux, dashboard et cycle de vie. **À ne pas copier :** code ou design sans examen de licence et attribution.

**Runner** — https://github.com/yicheng47/runner. Documentation : équipes de rôles, mission, chef d'équipe, terminaux natifs, fil d'événements persistant, demandes `ask_human`. Support indiqué macOS Apple Silicon et Windows x64, Linux non pris en charge à la date de consultation. **Forces :** mission/crew/feed, coordination concrète, séparation des rôles. **Limites :** compatibilité plateforme moins large ; approche native Rust/GPUI incompatible avec notre démarrage Electron. **À apprendre :** protocoles événements, règles d'escalade vers humain.

**Codey** — https://github.com/its-ahoh/codey. Documentation : agents Claude Code/Codex/OpenCode/pi, équipes, dispatch auto, mémoire par workspace, graphes de flux, voix, reprises, mode table ronde. **Forces :** proximité fonctionnelle avec notre vision ; configuration par rôle et graphes. **Limites :** application desktop macOS indiquée, maturité/robustesse à évaluer par essais ; ses fonctions invalidant toute revendication d'innovation exclusive. **À apprendre :** sémantique des graphes, séparation mémoire globale/projet et voix. **Ne pas réutiliser ses textes/prompts à l'identique.**

**Emdash** — https://github.com/generalaction/emdash. Documentation : Electron multiplateforme, agents CLI multiples, worktrees, revue des diffs, GitHub/issues/PR, SSH. **Forces :** isolation Git, flux PR et test/revue. **Limites :** coût de complexité du produit complet si cloné, impossibilité de présumer la sécurité de son isolation pour nos besoins. **À apprendre :** création/nettoyage des worktrees, revue, résolution conflits ; code open source sous conditions de sa licence.

**Pivio** — https://pivio.app/ (documentation commerciale à vérifier régulièrement). **Forces annoncées :** expérience unifiée et visibilité de l'utilisation. **Limites de l'analyse :** les mécanismes internes et capacités exactes ne sont pas vérifiés par audit de code. **À apprendre :** simplicité de configuration, affichage des limites de consommation.

**Principe légal :** s'inspirer de comportements et de flux utilisateur ne signifie pas copier des illustrations, logos, contenus, chaînes de prompts ou sources propriétaires. Avant tout copier-coller de code : vérifier licence, détenteur des droits, avis de copyright, NOTICE, dépendances, attribution, compatibilité Apache-2.0 et politiques de contribution.

## Chapitre 27 — Sources, documentation et révisions

**Références consultées le 10 octobre 2026 :**

- Electron Forge, template officiel Vite TypeScript : https://github.com/electron/forge/blob/main/docs/templates/vite-%2B-typescript.md
- Boilerplate alternatif Electron Vite React : https://github.com/electron-vite/electron-vite-react
- Hydra : https://github.com/jpdlr/hydra
- Runner : https://github.com/yicheng47/runner
- Codey : https://github.com/its-ahoh/codey
- Emdash : https://github.com/generalaction/emdash
- Pivio : https://pivio.app/
- Claude CLI : https://docs.anthropic.com/en/docs/claude-code/cli-usage
- Codex CLI : https://developers.openai.com/codex/cli/reference
- GitHub auth : https://cli.github.com/manual/gh_auth_login
- Vercel CLI : https://vercel.com/docs/projects/deploy-from-cli
- Apache-2.0 : https://www.apache.org/licenses/LICENSE-2.0.html

**Gestion des versions :** v0.1 vision ; v0.2 voix/GitHub/Vercel/sandbox/persistance ; v1.0 présent dossier de développement détaillé. Toute évolution requiert ticket, modification section, historique de version et, pour décision structurante, ADR. Ce document est une spécification de réalisation ; aucune fonctionnalité n'est déclarée déjà construite ou testée.
