# Installation et premiers pas (FR)

> Préversion **Linux uniquement**. Windows et macOS : aucun backend d'isolation vérifié ; l'exécution autonome y est refusée.

## Prérequis

| Élément | Version testée | Rôle |
|---|---|---|
| Ubuntu (ou Linux équivalent) | 24.04, noyau 7.0, x86_64 | plateforme de la préversion |
| Node.js | 24.18 | développement et tests |
| git | 2.43 | projets, worktrees isolés par tâche |
| bubblewrap (`bwrap`) | 0.9 | isolation des agents en `sandbox-auto` |
| user namespaces non privilégiés | activés | frontière d'arrêt et sandbox |
| systemd (session utilisateur) | 255 | limites de ressources (cgroups v2) |
| trousseau du bureau (GNOME Keyring / KWallet) | — | coffre des clés API (refus si absent) |
| CLI d'agents (facultatif) | Claude Code, Codex, Gemini CLI, Hermes, OpenCode | connecteurs CLI |
| `gh`, `vercel` (facultatif) | — | push/PR GitHub, déploiements Vercel |

Rien n'est installé ni authentifié automatiquement : chaque CLI s'installe et se connecte par sa procédure officielle.

## Depuis les sources

```bash
pnpm install --frozen-lockfile                 # seuls les modules natifs autorisés (allowBuilds) exécutent un script
pnpm run generate       # client Prisma + migrations embarquées
pnpm run check          # lint, typecheck, tests (les tests d'isolation exigent bwrap et les user namespaces)
pnpm start             # application en développement
```

Paquet Linux : `pnpm --filter @nexus/desktop run make:linux` (produit `.deb` et `.zip` dans `apps/desktop/out/make` ; le `.rpm` exige `rpmbuild`).

## Premiers pas

1. **Diagnostics** : la page d'accueil liste les CLI détectées (version, chemin) et l'état réel de l'isolation et du coffre.
   « Authentification non vérifiée » signifie que Nexus ne lit jamais les dossiers d'authentification des CLI.
2. **Projet** : créer un projet sur un dossier local. Pour qu'un agent puisse écrire, le dossier doit être un dépôt Git :
   chaque tâche travaille dans son propre worktree et sa branche `nexus/task-<id>`, jamais dans le dépôt principal.
3. **Fichiers `.env`** : visibles par défaut (décision du propriétaire). Activer « Protéger les fichiers .env » pour que les agents
   ne puissent ni les lire ni les afficher. Les fichiers d'identifiants (`.npmrc`, clés SSH…) sont toujours protégés.
4. **Équipe** : ajouter des agents (connecteur, rôle, mode de permission). Claude sous abonnement fonctionne en mode `manual`
   (décision D-1) ; `sandbox-auto` exige une isolation vérifiée et une connexion par clé API.
5. **Mission** : écrire l'objectif, puis proposer un plan (JSON) ou le demander au superviseur IA. Relire les règles de validation et
   le routage, approuver le plan, lancer. Chaque tâche terminée passe en **revue** (diff) avant d'être acceptée.
6. **Actions sensibles** : un push, une PR ou un déploiement créent une **approbation** (page Approbations) liée au plan exact ;
   la production Vercel demande toujours une approbation distincte.
7. **Arrêt d'urgence** : le bouton « Arrêter les agents » est toujours visible.

## Connecteurs API (facultatif)

1. Page « Connexions et secrets » : enregistrer la clé (elle est chiffrée par le trousseau de l'OS et n'est plus jamais réaffichée),
   avec l'usage `connector:<id>` (ex. `connector:openai-api`).
2. Créer `~/.config/Nexus AI/connectors.json` (dossier de données de l'application) :

```json
[{ "provider": "openai", "model": "<modèle choisi>", "secretRef": "openai:main" }]
```

Aucun modèle n'est choisi à votre place. Fournisseurs : `openai`, `anthropic`, `google`, `openrouter`.

## Dictée (facultatif)

Aucun moteur n'est actif par défaut. Fichier `voice.json` dans le dossier de données :

```json
{ "local": { "whisperPath": "/usr/local/bin/whisper-cli", "modelPath": "/chemin/vers/modele.bin" } }
```

ou, après consentement explicite à l'envoi de l'audio : `{ "cloud": { "optIn": true, "model": "<modèle>", "secretRef": "openai:main" } }`
(usage du secret : `voice:transcription`). L'audio n'est jamais conservé ; la transcription est toujours relue avant envoi.

## Données locales

Dossier de données de l'application : base `nexus.db` (journal d'événements), `secrets.json` (chiffré, 0600), `worktrees/`,
`artifacts/`. Export/import d'un projet depuis la page Projets (archive avec empreinte d'intégrité, sans secrets).
