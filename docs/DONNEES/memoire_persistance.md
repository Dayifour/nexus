# Memoire Persistance

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

**Source :** chapitres 11 de `SOURCES_ORIGINALES/Nexus_AI_SPEC_MASTER_v1.md`. Ce fichier est une extraction documentaire, sans remplacement du maître.

## Chapitre 11 — Persistance : modèle de données et reprise

**Tables principales :** `projects`, `repositories`, `teams`, `agent_profiles`, `connections`, `provider_accounts` (métadonnées seulement), `sessions`, `messages`, `missions`, `tasks`, `task_dependencies`, `agent_runs`, `events`, `artifacts`, `file_changes`, `worktrees`, `approvals`, `permission_policies`, `usage_snapshots`, `deployment_runs`, `voice_transcripts`, `decisions`, `memory_entries`, `schema_migrations`.

**Champs minimum communs :** UUID, `created_at`, `updated_at` si modifiable, version de schéma, références, statut enum. `events` a `event_id`, `aggregate_id`, `sequence`, `occurred_at`, `event_type`, `payload_json_redacted`, `correlation_id`. Unicité `(aggregate_id, sequence)` ; projection transactionnelle ; événement enregistré avant signal UI. `agent_runs` stocke `native_session_id`, connecteur/version, PID éventuel, état, timestamps. PID seul ne suffit pas pour reprendre après reboot.

**Reprise :** démarrage -> migration sauvegardée -> réparation projections par replay -> interrogation des processus encore vivants -> tous les `running` sans runner valide deviennent `interrupted` -> bouton `Reprendre` -> native resume si supportée, sinon nouveau run utilisant contexte reconstruit ; avertissement utilisateur pour actions non idempotentes. En fin de session, flush logs + sqlite checkpoint ; après crash, derniers événements déjà committés restent disponibles.

**Sauvegarde :** export versionné de projets/décisions/conversations avec secrets expurgés et chemins personnalisables ; restauration avec vérifications d'intégrité. Politique de rétention configurable, suppression vérifiable. Ne pas enregistrer le contenu des variables secrets dans `messages`, `events`, `logs`, traces ou exports.
