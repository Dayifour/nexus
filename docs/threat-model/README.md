# Modèle de menace — Nexus AI (Linux)

État au 11/10/2026. Cahier maître §12 : « pour chaque menace, test automatisé et procédure d'incident ».
Portée : hôte Ubuntu/Linux. Windows et macOS n'ont **aucun backend de sandbox** : `sandbox-auto` y est refusé.

## Frontières de confiance

```
Renderer (non fiable) ─IPC validé (preload + main)─> Main Electron ─> Services / domaine ─> Runner
                                                                         │                    │
                                                          Journal SQLite (expurgé)   PID namespace ; en sandbox-auto :
                                                          Coffre (safeStorage)       systemd scope + bwrap + seccomp + proxy
```

## Menaces, défenses et preuves

| # | Menace | Défense | Preuve automatisée |
|---|---|---|---|
| M1 | Renderer compromis (XSS, contenu de dépôt) appelle Node ou des API arbitraires | `contextIsolation`, `nodeIntegration:false`, sandbox Chromium, pont gelé à 3 fonctions, IPC validé deux fois, CSP sans `unsafe-eval`, navigation/fenêtres/webviews bloquées, expéditeur vérifié | `apps/desktop/e2e/security.e2e.ts` (8 tests), `apps/desktop/tests/ipc-dispatch.test.mts` |
| M2 | Lecture de `.env`, clés SSH, identifiants par un agent | clés SSH, `.npmrc`, coffre et reste du HOME jamais montés ; **exception assumée** : la session du CLI de l'agent (ex. `~/.claude`) est montée en lecture-écriture dans SA sandbox (voir M19) ; identifiants du workspace toujours masqués ; `.env*` masqués si protection activée (D-4) | `packages/sandbox/test/sandbox.test.ts` (AC-06, D-4), `tests/security/t001/` |
| M3 | Écriture hors worktree, modification silencieuse du dépôt principal | modes « Autonome en sandbox » et « Avec validation » : worktree par tâche (ADR-008) ; **mode Autonome : l'agent écrit directement dans le dossier du projet, par choix du propriétaire (pas de worktree, pas de revue)** ; racine du sandbox en lecture seule, merge seulement avec approbation liée à l'état | `packages/app-services/test/app-services.test.ts` (dépôt principal intact), `packages/git/test/` (AC-03, merge) |
| M4 | Exfiltration réseau | sandbox sans réseau ; seule sortie : proxy CONNECT en liste blanche, IP privées et rebinding refusés, décisions journalisées | `packages/sandbox/test/sandbox.test.ts` (AC-07) |
| M5 | Évasion du confinement (namespaces, montages, noyau) | seccomp (unshare, setns, clone avec namespaces, mount, bpf, ptrace, keyctl, modules…), capacités nulles, `no_new_privs` | `packages/sandbox/test/sandbox.test.ts` (seccomp) |
| M6 | Processus agent qui survit à l'annulation (setsid, double fork) | frontière PID namespace (unshare ou bwrap), SIGKILL du namespace | `packages/process-supervisor/test/run.test.ts`, test setsid du sandbox |
| M7 | Épuisement de ressources (fork bomb, mémoire) | si systemd --user est disponible, cgroups v2 : `TasksMax`, `MemoryMax` + `MemorySwapMax=0`, plafond de sortie | `packages/sandbox/test/sandbox.test.ts` (cgroups), `run.test.ts` (plafond de sortie) |
| M8 | Injection de commande / d'options | `spawn` sans shell, tableau d'arguments, `--` et `--end-of-options` pour git, validation des réfs | `run.test.ts` (argument hostile), `packages/git/test/` (noms malveillants) |
| M9 | Substitution de binaire dans le PATH | entrées relatives ignorées, exécutable modifiable par tous refusé, chemins absolus uniquement | `run.test.ts` (résolution PATH) |
| M10 | Jeton dans les logs, le journal, l'UI, les exports | expurgation par valeur connue (broker) et par motif, avant écriture ; clés API jamais dans argv ni dans l'UI | `packages/secrets/test/secrets.test.ts` (rouge/vert), `packages/connectors-api/test/` (AC-09), `packages/event-store/test/` |
| M11 | Stockage de secrets en clair | coffre de l'OS (safeStorage) ; backend factice refusé ; fichier 0600 | `packages/secrets/test/secrets.test.ts` |
| M12 | Prompt injection (issue, README) qui pousse à une action sensible | le modèle ne détient aucun secret ; actions sensibles soumises au moteur de politiques et à une approbation humaine (empreinte, expiration, usage unique) | `packages/core/test/domain.test.ts` (approbations, politique) |
| M13 | Escalade agent-vers-agent | messages = données ; seul l'utilisateur répond aux approbations et change les permissions | `packages/core/test/domain.test.ts` (bus, approbations, D-1) |
| M14 | Erreurs de reprise (faux « running », rejeu d'actions) | réparation au démarrage -> `interrupted` ; reprise native ou contexte reconstruit avec avertissement | `packages/core/test/domain.test.ts` (UC-05/AC-05), `event-store` (crash SIGKILL) |
| M15 | Corruption du journal | append-only par triggers, transactions événement+projection, WAL + `synchronous=FULL` | `packages/event-store/test/event-store.test.ts` |
| M16 | Scripts postinstall malveillants | pnpm n'exécute que les scripts autorisés dans `pnpm-workspace.yaml` (allowBuilds : node-pty, electron) | constat d'installation (docs/licences/AUDIT.md) |
| M17 | Micro activé silencieusement | permission « media » refusée sauf audio, pendant une fenêtre armée par un clic, depuis l'application | `packages/voice/test/`, `packages/app-services/test/` (voix), E2E permissions |
| M18 | Push/déploiement non désiré | approbation obligatoire et distincte pour la production ; force-push et suppression distante non implémentés | `packages/github/test/`, `packages/deploy-planner/test/` (T-018/T-019) |

| M19 | Agent sandboxé qui lit, altère ou exfiltre la session de son fournisseur | choix du propriétaire (D-1 levée) pour que le CLI fonctionne en sandbox : seule la session de CE fournisseur est montée, et le réseau est limité aux domaines de ce fournisseur (+ domaines ajoutés). Un agent compromis peut donc abuser de cette session auprès du fournisseur ; il ne peut pas l'envoyer vers un domaine non autorisé | `packages/app-services/test/workspace.test.ts` (sandbox réelle : réseau direct coupé, CONNECT hors liste refusé) |
| M20 | Renderer compromis qui utilise les capacités légitimes de l'IDE (terminal utilisateur, écriture de fichiers, lancement d'agent) | **risque résiduel assumé, comme dans tout IDE Electron (VS Code)** : la frontière repose sur l'absence d'exécution de script étranger dans le renderer (CSP stricte sans `unsafe-eval` ni script distant, aucun contenu web chargé, Mermaid en mode strict, sorties du terminal rendues par xterm et jamais en HTML). Les actions qui élargissent la confiance sont confirmées par une **boîte de dialogue native du main**, hors d'atteinte du renderer : domaines ajoutés à la sandbox ; push et production restent confirmés | E2E sécurité (CSP, navigation), `workspace.test.ts` (confirmation native des domaines) |
| M21 | Sortie massive d'un terminal qui sature l'IPC ou l'interface | sortie regroupée (16 ms, 256 Ko maximum par envoi), PTY mis en pause au-delà de 4 Mo en attente | `workspace.test.ts` (3 Mo sans perte, envois bornés) |
| M22 | Abus du bus de l'équipe (Orchestre) : usurpation d'un agent, accès depuis un autre processus | socket Unix dans un dossier privé 0700 (socket 0600), jeton aléatoire par tâche révoqué en fin de mission, messages bornés (8 Ko), aucun accès fichier ni commande via le bus (seulement état, messages, question au chef en lecture seule) ; indisponible en sandbox | `packages/app-services/test/orchestra.test.ts` (serveur MCP réel, jeton révoqué refusé) |
| M23 | Déploiement : MITM SSH, base exposée | empreinte de clé hôte SSH exigée et vérifiée avant tout envoi ; utilisateur Atlas limité à la base applicative, plage réseau explicite (ouverture totale seulement sur case explicite) | `packages/deploy-planner/test/planner.test.ts` |
| M24 | Agent sandboxé qui modifie la config git du dépôt (filtre `clean`/`smudge`/`process`, pilote de diff/merge, `include`, `core.sshCommand`…) ou le pointeur `.git` d'un worktree, pour qu'un `git add`/`status`/`merge` lancé **sur l'hôte** par Nexus exécute sa commande hors sandbox | métadonnées git montées **en lecture seule** dans la sandbox (`.git`, et pour un worktree le pointeur, le gitdir et le commondir s'ils sont visibles) : git reste lisible (status, log, diff) mais les commits sont faits par Nexus ; Git broker : config local/worktree (includes suivis) refusée (`UNSAFE_REPO_CONFIG`) si elle contient une clé exécutable non neutralisable, autres commandes (éditeur, pager, ssh, credential, gpg, gc auto, fsmonitor, hooks) neutralisées par `-c`, sous-modules non parcourus, gitdir d'un worktree de tâche vérifié contre le dépôt principal (pointeur retour + `worktree list`) | `packages/git/test/broker.test.ts` (filtre malveillant : marqueur absent, include, config de worktree, pointeur falsifié), `packages/sandbox/test/sandbox.test.ts` (écriture de `.git/config` et du pointeur : EROFS) |

## Risques résiduels connus

- **Sans cgroups** (pas de systemd --user), la sandbox reste confinée (fichiers, réseau, seccomp, PID) mais **sans plafond mémoire ni processus** : l'état « sandbox dégradée » doit être affiché.
- **Config git en mode Autonome** (sans sandbox) : l'agent s'exécute déjà sur l'hôte, la vérification de config du broker n'est alors qu'un garde-fou. Les commandes git lancées hors du broker (ex. `packages/github`) ne bénéficient pas de la vérification `UNSAFE_REPO_CONFIG`.
- **Terminal utilisateur** : c'est le shell de l'utilisateur, avec son environnement ; ce qu'il affiche (y compris des secrets que l'utilisateur affiche lui-même) est visible dans l'interface. Il n'est jamais donné aux agents.


Voir ADR-001 §8 et ADR-003 : masquage calculé au démarrage, allowlist par nom d'hôte sans inspection TLS, seccomp en liste de refus,
dépendance aux user namespaces et à AppArmor, absence de backend Windows/macOS, preuve du geste utilisateur non vérifiable par le main
pour la dictée (atténuée par la fenêtre courte et la permission de l'OS).

## Procédure d'incident

1. **Arrêt d'urgence** : bouton « Arrêter les agents » (annule toutes les exécutions ; les processus sont tués par leur namespace).
2. **Révocation** : supprimer le secret concerné dans « Connexions et secrets », puis le révoquer chez le fournisseur.
3. **Analyse** : le journal (`events`) est en ajout seul ; exporter la mission et ses runs pour examen (les charges sont expurgées).
4. **Isolation** : passer l'équipe en mode `manual` ou `read-only` ; désactiver `sandbox-auto`.
5. **Correction** : ajouter un test reproduisant l'incident avant tout correctif (règle de contribution §23).
