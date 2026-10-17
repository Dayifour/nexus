# Matrice d'acceptation (T-023)

État au 11/10/2026, revu le 16/10/2026, hôte Ubuntu 24.04 (noyau 7.0, x86_64). Légende : **réel** = exécuté contre le vrai composant ;
**fixture** = composant simulé de façon contrôlée ; **bloqué** = impossible sur cet hôte sans action du propriétaire.

| AC | Critère | Preuve | Nature | Statut |
|---|---|---|---|---|
| AC-01 | CLI absent / présent non authentifié / présent authentifié détectés sans crash | `packages/connectors/test` (sonde : absent, version, format inconnu, blocage, binaire modifiable par tous) ; inventaire réel de l'hôte (Claude 2.1.296, Hermes, git) | réel + fixture | ✅ ; « authentifié » reste *non vérifié* par conception (aucune lecture des dossiers d'auth) |
| AC-02 | Deux fournisseurs collaborent et transmettent leur travail | `packages/app-services/test/orchestra.test.ts` (plan, DAG, transmission, revue) ; `apps/desktop/e2e/real-agents.e2e.ts` (`NEXUS_REAL_AGENTS=1`) : orchestre Claude → Codex, échanges par le bus MCP | fixture + réel | ✅ |
| AC-03 | 2 worktrees isolés ; conflit remonté sans écrasement | `packages/git/test` (vrais dépôts : worktrees concurrents, conflit, dépôt principal intact) | réel | ✅ |
| AC-04 | Kill forcé pendant un événement ; données relues ; session `interrupted` | `packages/event-store/test` (3× SIGKILL pendant l'écriture) ; `packages/core/test` (redémarrage -> `interrupted`) | réel | ✅ |
| AC-05 | Reprise native quand compatible ; repli déclaré sinon | `packages/core/test` (native `--resume` / contexte reconstruit + avertissement) ; arguments `--resume` vérifiés sur Claude | fixture + réel (CLI) | ✅ |
| AC-06 | `.env`, clés SSH, hors workspace inaccessibles à un agent sandboxé | `packages/sandbox/test` (fichiers hors montage, clés, identifiants ; `.env` selon D-4) | réel | ✅ (D-4 : `.env` protégé seulement si l'option est active) |
| AC-07 | Egress non autorisé bloqué et enregistré | `packages/sandbox/test` (TCP direct impossible, proxy 403, IP privée/rebinding refusés, journal) | réel | ✅ |
| AC-08 | Confirmation avant push, PR, production Vercel | `packages/core/test` (approbations : empreinte, expiration, usage unique) ; `packages/github/test`, `packages/deploy-planner/test` ; confirmations par dialogue natif | fixture (`gh` simulé, API d'hébergeurs simulées) | ✅ en fixture ; essai réel **bloqué** (comptes et authentification requis) |
| AC-09 | Clé API jamais dans export/log/UI/ligne de commande/payload agent | `packages/secrets/test` (rouge/vert), `packages/connectors-api/test`, `packages/app-services/test` (secrets jamais renvoyés), archive FR-025 expurgée | réel (expurgation) + fixture (fournisseurs) | ✅ |
| AC-10 | Quota inconnu affiché « indisponible », jamais 0 %/100 % fictif | `packages/usage/test` (`describeQuota`), `packages/app-services/test` (`usage.summary` -> indisponible) | réel | ✅ |
| AC-11 | Audio consenti, transcription modifiable, aucun enregistrement silencieux | `packages/voice/test`, `packages/app-services/test` (voix), E2E permissions (micro refusé par défaut) | fixture (aucun moteur STT installé) | ✅ logique ; dictée réelle **bloquée** tant qu'aucun moteur n'est installé ou qu'aucun consentement cloud n'est donné |
| AC-12 | Smoke tests installateurs Ubuntu/Windows/macOS | T-024 : paquet Linux construit et démarré | réel (Linux) | Linux seulement ; Windows/macOS **bloqués** (machines réelles requises) |
| AC-13 | Prompt injection « imprime le secret » ignorée/bloquée | l'agent ne détient aucun secret (broker), le sandbox ne monte pas les identifiants, actions sensibles soumises à approbation | réel (isolation) | ✅ par construction ; pas de test sur modèle réel |
| AC-14 | Erreur réseau, limite fournisseur, CLI absent, version inconnue gérés | `packages/connectors-api/test` (401/429/5xx/coupure/timeout), `packages/connectors/test` (absent, version inconnue) | fixture | ✅ |

## Exécution

- `pnpm run check` : lint, formatage, typecheck, tests unitaires et d'intégration (hors E2E).
- E2E Electron sur le paquet (comme en CI) : `cd apps/desktop && pnpm exec electron-forge package && xvfb-run -a node --test --test-concurrency=1 e2e/security.e2e.ts e2e/ui.e2e.ts`. Nombre de tests et résultats : voir la CI (`.github/workflows/ci.yml`).
- `pnpm --filter @nexus/desktop run make:linux` puis `xvfb-run -a node --test e2e/package-smoke.e2e.ts` : smoke test du `.deb`.
- Les suites sandbox et PID namespace **échouent** (au lieu d'être ignorées) si l'isolation est indisponible, sauf
  `NEXUS_ALLOW_NO_USERNS=1` explicite. La CI lève la restriction AppArmor sur le runner et exécute réellement ces suites.

## Revue indépendante

Le cahier maître demande qu'un agent QA ne valide pas ses propres correctifs. Les packages produits par des sous-agents
(connecteurs API, Git, usage, GitHub, déploiement, interface) ont été revus par l'agent responsable : exécution des tests,
typecheck, contrôle ciblé des points de sécurité (absence de shell, environnement non hérité, redirections interdites, approbations).
Une revue humaine reste nécessaire avant toute publication.
