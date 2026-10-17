# Exemples de séquences et responsabilités

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

## Mission automatique
```mermaid
sequenceDiagram
  actor U as Utilisateur
  participant UI as UI Electron
  participant C as Core Orchestrator
  participant S as Sandbox/Policy
  participant A as Claude CLI
  participant B as Codex CLI
  participant DB as SQLite
  U->>UI: Demande « application de stock »
  UI->>C: mission.create(prompt, teamId)
  C->>DB: mission-created
  C->>C: Plan DAG et choix des agents
  C->>S: Vérifier chemins, outils, budget
  S-->>C: autorisation et worktrees
  par Exécution indépendante
    C->>A: tâche backend
    C->>B: tâche interface
  end
  A-->>C: événements et artefacts
  B-->>C: événements et artefacts
  C->>DB: journal, snapshots, résultats
  C-->>UI: diff + proposition de review
  U->>UI: Accepte intégration / refuse
```

## Reprise après arrêt
```mermaid
stateDiagram-v2
 [*] --> queued
 queued --> running
 running --> interrupted: arrêt/redémarrage
 interrupted --> resuming: action utilisateur
 resuming --> running: native resume OU prompt contrôlé
 resuming --> failed: impossible sans perte acceptable
 running --> waiting_review
 waiting_review --> completed
```

## Exemple de politique de fichiers
Projet repo isolé : `/workspace/<task-id>` en lecture-écriture ; montage de contrats explicitement autorisés ; `~/.ssh`, `.aws`, `.config` et `.env` non montés ; connecteurs spécialisés utilisent leurs credentials dans un processus broker indépendant du CLI agent. Les chemins exacts diffèrent selon OS.
