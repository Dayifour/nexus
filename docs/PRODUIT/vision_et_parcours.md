# Vision Et Parcours

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

**Source :** chapitres 1, 4, 5, 25 de `SOURCES_ORIGINALES/Nexus_AI_SPEC_MASTER_v1.md`. Ce fichier est une extraction documentaire, sans remplacement du maître.

## Chapitre 1 — Mission et vision

Nexus AI réunit dans une seule application des agents de programmation accessibles par CLI (Claude Code, Codex, Gemini CLI, Hermes et connecteurs futurs) et des modèles accessibles par API (OpenAI, Anthropic, Google AI Studio, OpenRouter, serveurs locaux et futurs fournisseurs). L'utilisateur crée un ou plusieurs projets, forme plusieurs équipes, choisit une gouvernance manuelle ou un superviseur IA, assigne des missions, observe les actions en temps réel et retrouve tous ses projets, conversations, tâches et décisions après la fermeture de l'application.

**Différenciation visée, non encore prouvée :** plateforme réellement extensible API + CLI, gouvernance configurable, mémoire partagée vérifiable, suivi d'utilisation prudent, sécurité effective des processus, GitHub et Vercel intégrés, dictée vocale, assistance à l'architecture et au déploiement. L'existence de concurrents possédant individuellement plusieurs de ces fonctions interdit de revendiquer leur nouveauté sans validation de marché.

**Utilisateurs prioritaires :** développeur indépendant, consultant, mainteneur open source, équipe technique de petite taille. **Positionnement :** coding-agent workbench, et non chatbot généraliste. Les recherches, résumés et documents sont des fonctions au service du travail logiciel.

## Chapitre 4 — Parcours utilisateurs (exemples exécutables)

**UC-01 Première installation :** ouvrir Nexus AI sur Ubuntu ; l'outil inspecte *en lecture seule* PATH pour `claude`, `codex`, `gemini`, `hermes`, `opencode`, `git`, `gh`, `vercel`; lit version via commandes non interactives sûres avec timeout ; expose `installed`, `version`, `path`, `capabilities`, `authStatus` (si test autorisé). Aucun téléchargement ou `login` automatique. Un bouton « Configurer » conduit à l'authentification officielle.

**UC-02 Session manuelle :** utilisateur charge un dépôt ; crée équipe « Architecte, Backend, Frontend, QA » ; assigne agent A au backend et B au frontend ; chacun peut lire les contrats, travaille en worktree isolé ; utilisateur voit tâches, messages, diff, logs, temps et budgets.

**UC-03 Mode IA :** utilisateur désigne Codex ou Claude comme « superviseur » ; demande « ajoute authentification et tests » ; superviseur propose un DAG, chaque tâche ayant fichiers cibles, entrées, sortie attendue, dépendances et critères ; règles vérifient autorisations et budgets ; exécution parallèle seulement si les chemins et dépendances le permettent ; intégration après review.

**UC-04 Consultation pair-à-pair :** agent Frontend envoie « quel contrat JSON de connexion ? » à Backend ; bus d'événements enregistre demande ; Backend répond avec schéma versionné ; le superviseur n'intervient pas tant qu'il n'y a ni nouvelle permission ni modification de périmètre ; messages visibles et filtrables.

**UC-05 Retour après fermeture :** quitter app ; la base conserve conversation, décisions, tâches, snapshots, sessions natives et dernière séquence d'événements ; au redémarrage l'interface réhydrate le projet. Une tâche arrêtée devient `interrupted` ; « reprendre » utilise le jeton/ID de session CLI si disponible, sinon crée un nouveau tour avec résumé contrôlé. Ne jamais afficher `running` sans processus actif vérifié.

**UC-06 Github :** voir diff ; sélectionner fichiers ; committer ; créer branche ; demander push ; écran de validation présente repo, branche distante, commits, fichiers, éventuels secrets détectés et effet ; utilisateur confirme. Mode automatique n'autorise pas d'emblée push/force push.

**UC-07 Déploiement Vercel :** détecter framework ; vérifier build et permissions ; montrer projet/équipe cible, variables requises et coût potentiel ; lancer `vercel deploy` pour preview après consentement ; collecter URL de preview et logs ; prod via confirmation distincte. Les identifiants ne sont pas exposés aux agents génériques.

**UC-08 Dictée :** appui micro explicite, vérification autorisation OS ; transcription locale si moteur compatible choisi, ou cloud après consentement ; l'utilisateur corrige le texte puis envoie ; audio supprimé ou conservé selon préférence. Ne jamais démarrer un enregistrement silencieusement.

**UC-09 Protection `.env` :** un agent demande `cat .env` ; broker refuse si chemin protégé même si la commande shell est reformulée ; sandbox n'a pas monté le fichier ; journal affiche le refus sans afficher son contenu. Un secret nécessaire au déploiement est utilisé par un connecteur spécialisé dans le périmètre autorisé, pas recopié dans le chat.

**UC-10 Architecture :** « Dessine l'architecture de mon API » ; l'agent analyse les fichiers autorisés, génère Mermaid, identifie services/dépendances et propose ADR ; rien n'est déployé sans décision séparée.

## Chapitre 5 — Exigences fonctionnelles (catalogue traçable)

| ID | Priorité | Exigence et résultat observable |
|---|---|---|
| FR-001 | MVP | Projet ouvrir/créer, associer dépôt Git local et chemin valide |
| FR-002 | MVP | Plusieurs projets et plusieurs équipes sauvegardés |
| FR-003 | MVP | Inventaire CLI démarrage + rafraîchissement manuel, sans auth intrusive |
| FR-004 | MVP | Connecteur CLI Claude Code et Codex, priorité du premier jalon |
| FR-005 | MVP | Adaptateur générique CLI ; Gemini CLI, Hermes suivant compatibilité testée |
| FR-006 | MVP | Adaptateurs API OpenAI, Anthropic, Google et OpenRouter ; protocole unifié |
| FR-007 | MVP | Support de plusieurs profils/comptes par fournisseur dans les limites autorisées |
| FR-008 | MVP | Mode manuel ; création/affectation/annulation de tâches |
| FR-009 | MVP | Superviseur IA choisi par utilisateur et routage capacités/coût/risque |
| FR-010 | MVP | DAG de tâches et exécution simultanée dans worktrees distincts |
| FR-011 | MVP | Messages inter-agents structurés et journal visibles |
| FR-012 | MVP | Historique conversations/événements persistant et reprise contrôlée |
| FR-013 | MVP | Affichage sorties streaming, statut tâches, fichiers et erreurs |
| FR-014 | MVP | Permissions `manual`, `notify`, `sandbox-auto` configurées |
| FR-015 | MVP | Sandbox d'exécution réelle, pas seulement masquage GUI |
| FR-016 | MVP | Secret guard, coffre credentials et redaction des sorties |
| FR-017 | MVP | Git diff, commit, branch, GitHub auth et push confirmé |
| FR-018 | MVP | Déploiement Vercel preview + confirmation production et logs |
| FR-019 | MVP | Saisie vocale au choix + édition de transcription avant envoi |
| FR-020 | MVP | Quotas/usage : réel, estimé ou indisponible, horodaté + source |
| FR-021 | MVP | Plan d'architecture et diagramme Mermaid exportables |
| FR-022 | MVP | UI explorateur/éditeur Monaco, terminaux, tâches, mémoire, activité |
| FR-023 | MVP | Arrêt d'urgence : tuer processus et marquer tâches interrompues |
| FR-024 | MVP | Paramétrage budget, timeouts, limites de boucles et nombre d'agents |
| FR-025 | MVP | Import/export local d'un projet avec secrets exclus |
| FR-026 | PLUS TARD | Conseil IA multi-propositions, activable sans obligation |
| FR-027 | PLUS TARD | Connecteurs hébergement VPS, Docker distant, autres clouds |
| FR-028 | PLUS TARD | Collaboration humaine en ligne et partage distant des sessions |

**Priorités MVP ≠ livrables du premier soir.** Le premier jalon interne couvre FR-001,003,004,008,010,011,012,013 en environnement restreint ; une release publique attend notamment FR-015 à FR-019 et tests plateforme.

## Chapitre 25 — Démonstration référence : « application de gestion de stock »

**Input :** « Construis une petite application de stock : connexion, catalogue produits (SKU, prix, quantité), entrées/sorties, alertes de seuil, tests ». Superviseur propose tâches : A modèle données/backend ; B interface produits ; C tests ; D intégration et review ; E diagramme et README ; F preview Vercel si compatible. Chaque tâche déclare chemins exclusifs, tests, sortie et dépendances. Sur GitHub : branche et PR revue ; Vercel preview après consentement. **Mesures :** durée totale, conflits évités, nombre de corrections, coût estimé/reported, actions refusées, possibilité de reprise après interruption.

**Critère de réussite de la démo :** l'application stock démarre localement ; opérations CRUD + inventaire tests passent ; tous événements Nexus AI sont récupérables ; secrets non exposés ; le projet Git dispose d'un diff lisible, et la preview n'est produite que si l'architecture est compatible avec Vercel.
