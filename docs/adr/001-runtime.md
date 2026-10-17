# ADR-001-runtime — Exécution des agents CLI, streaming et confinement Linux

- **Statut :** proposée, révision 2 (après la relecture d'Hermes du 10/10/2026 : « changements demandés »).
  D-2 et D-3 sont tranchées par l'architecte (§7) ; D-1 et D-4 attendent le propriétaire.
- **Date :** 10 octobre 2026.
- **Ticket :** T-001 — POC streams + permissions + sandbox spike.
- **Portée :** Ubuntu/Linux uniquement. Aucune conclusion pour Windows ni macOS.
- **Sources :** `docs/SOURCES_ORIGINALES/Nexus_AI_SPEC_MASTER_v1.md` §7, §9, §12, §19, §20 ; `docs/SECURITE/politique.md` ; `docs/SECURITE/matrice_permissions.md` ; `docs/runbooks/environment.md` (T-000).
- **Preuves :** `spikes/t001/**`, `tests/security/t001/**`.

## 1. Contexte

Le cahier maître impose (SEC-001..008, ADR-009) que les processus CLI des agents s'exécutent dans un runner
soumis à une isolation OS réelle, que les secrets soient absents du sandbox plutôt que filtrés, que le réseau
soit refusé par défaut ou limité à une liste blanche, et que l'absence d'isolation entraîne un **refus** des
actions autonomes dangereuses. T-001 doit établir, avant le bootstrap T-002, si ces exigences sont réalisables
sur l'hôte de développement et avec quel mécanisme, et vérifier que le flux structuré de Claude Code peut être
lu et arrêté proprement.

## 2. Environnement réellement mesuré (10/10/2026)

| Élément | Valeur | Remarque |
|---|---|---|
| OS / noyau | Ubuntu 24.04.4 LTS, 7.0.0-34-generic, x86_64 | |
| Node (utilisé par les tests) | v24.18.0 (nvm, sous `$HOME`) | **`/usr/bin/node` v18.19.1 existe aussi** : le runner devra fixer explicitement le binaire Node utilisé |
| bubblewrap | 0.9.0, `/usr/bin/bwrap`, propriétaire root, **non setuid** | fonctionne en namespaces utilisateur non privilégiés |
| `kernel.apparmor_restrict_unprivileged_userns` | 1 | restriction active ; bwrap fonctionne néanmoins (vérifié par test). La compatibilité dépend de la politique AppArmor de la distribution : à re-sonder à chaque démarrage |
| Docker | 29.8.0, démon **rootful** (`/var/run/docker.sock`), utilisateur membre du groupe `docker` | `rootlesskit` et `dockerd-rootless.sh` présents mais mode rootless **non configuré** (pas de socket utilisateur) |
| Podman | absent | |
| Claude Code | **2.1.296** | le runbook T-000 indique 2.1.291 : le CLI s'est mis à jour entre-temps. Conséquence : les formats de flux ne doivent jamais être supposés stables |
| Codex CLI | absent | **aucune compatibilité Codex n'est revendiquée** |

## 3. Preuves obtenues

Commande : `node --test 'tests/security/t001/*.test.mjs'` → **45 réussis, 0 échec, 2 ignorés (opt-in réel)** (révision 2).
Commande opt-in réelle : `NEXUS_T001_REAL_CLAUDE=1 NEXUS_T001_CLAUDE_BIN=… node --test tests/security/t001/claude-real.test.mjs` → **2 réussis** (essai réel, non simulé, relancé après le correctif de la révision 2).

### 3.1 Streaming Claude (`claude --print --output-format stream-json --verbose`)

| Preuve | Type | Résultat |
|---|---|---|
| Séquence observée en 2.1.296 : `system/init` → `assistant` → `rate_limit_event` → `result` | réel | confirmé |
| Normalisation vers `started → output → usage → completed`, séquences croissantes | fixture assainie | ✔ |
| Flux réel « pong » parsé de bout en bout | **réel** | ✔ (≈4,4 s) |
| Annulation réelle après le premier événement, arrêt < 3 s (NFR-005) ; aucun processus Claude restant observé après le test | **réel** | ✔ |
| Objets JSON découpés arbitrairement entre chunks, UTF-8 multi-octets coupé | fixture | ✔ |
| Ligne invalide comptée, flux non interrompu ; type inconnu ignoré et compté | fixture | ✔ |
| Ligne surdimensionnée rejetée sans accumulation mémoire | fixture | ✔ |
| Champs `init` sensibles (`memory_paths`, `apiKeySource`, chemins `$HOME`, socket) jamais propagés | fixture | ✔ |
| Flux terminé sans `result` → `failed/stream_ended_without_result`, jamais succès implicite | fixture | ✔ |

### 3.2 Cycle de vie des processus

| Preuve | Résultat |
|---|---|
| Argument hostile `x; touch …` transmis littéralement (`shell:false`), aucun fichier créé | ✔ |
| Binaire relatif refusé (pas de résolution `PATH` → pas de substitution de binaire) | ✔ |
| Environnement explicite : aucune variable du parent ne fuit | ✔ |
| **Faille démontrée** : avec la seule frontière groupe de processus (`kill(-pgid)`), un descendant lancé via `/usr/bin/setsid` survit à l'annulation (relevé par Hermes, reproduit par un test adversarial) | ✔ (la faille est prouvée) |
| Frontière PID namespace (défaut) : descendant `setsid` tué après AbortSignal, en < 3 s | ✔ |
| Frontière PID namespace : descendant `setsid` tué après timeout | ✔ |
| Frontière PID namespace : parent ignorant SIGTERM, escalade SIGKILL, descendant `setsid` tué | ✔ |
| Frontière PID namespace : fin normale du parent, le « démon » `setsid` laissé derrière est tué | ✔ |
| Frontière inconnue refusée, pas de repli silencieux | ✔ |
| Dans le sandbox bwrap : descendant `setsid` tué à l'annulation | ✔ |
| Processus ignorant SIGTERM : escalade SIGKILL après délai de grâce | ✔ |
| Binaire absent → `ENOENT` normalisé (AC-14) | ✔ |
| Redaction de valeurs secrètes connues sur stdout/stderr (par ligne) | ✔ |

### 3.3 Confinement bubblewrap (fixtures inoffensives, aucun vrai secret lu)

| Preuve | Exigence | Résultat |
|---|---|---|
| Lecture / écriture dans le workspace monté | `sandbox-auto` | ✔ |
| Fichier hors workspace (chemin hôte absolu) : `ENOENT` (non monté) | SEC fichiers non montés, AC-06 | ✔ |
| Clé SSH fixture d'un faux HOME : `ENOENT` ; HOME hôte absent ; `HOME=/home/agent` (tmpfs) | AC-06 | ✔ |
| `.env` et `config/.env.local` du workspace masqués : `EACCES`, fichier hôte intact | UC-09 | ✔ |
| Symlinks du workspace vers fichier / dossier extérieur : cible absente → `ENOENT` | SEC symlinks | ✔ |
| Écriture dans `/usr`, `/etc`, `/`, `/opt` : `EROFS` ; `/tmp` privé et éphémère | SEC écriture | ✔ (après correctif, §4.1) |
| Environnement vidé (`--clearenv`) : seules `HOME, LANG, PATH, PWD, TMPDIR` + variables allowlistées | AC-09 | ✔ |
| `CapEff=0`, `CapBnd=0`, `NoNewPrivs=1` | moindre privilège | ✔ |
| PID namespace : processus hôtes invisibles | | ✔ |
| TCP externe : `ENETUNREACH` ; service hôte sur 127.0.0.1 : `ECONNREFUSED` | réseau refusé par défaut, AC-07 | ✔ |
| Annulation : arbre de processus du sandbox tué < 3 s | FR-023, NFR-005 | ✔ |

### 3.4 Réseau en liste blanche

Le sandbox n'a **aucune interface réseau** ; le seul canal sortant est un socket Unix monté vers un proxy
`CONNECT` côté hôte qui applique une allowlist exacte `hôte:port` et journalise chaque décision. Un pont interne
(`fixtures/proxy-bridge.mjs`) expose ce socket sur la loopback privée du sandbox pour les clients `HTTPS_PROXY`.

| Preuve | Résultat |
|---|---|
| Destination allowlistée : tunnel établi (vers une fixture locale, jamais Internet), décision `allow` journalisée | ✔ |
| Destination non allowlistée : `403`, décision `deny` journalisée, aucune donnée amont | ✔ |
| TCP direct depuis le sandbox toujours `ENETUNREACH`, même en mode proxy | ✔ |
| Requête non-CONNECT, malformée ou hôte piégé (`host:443@evil`) : `400/403/405`, proxy stable | ✔ |

### 3.5 Claude Code exécuté dans bwrap (sonde manuelle)

Claude 2.1.296 démarre dans le profil bwrap (binaire monté en lecture seule, HOME tmpfs, sans magasin
d'authentification). Avec ou sans réseau, il **échoue fermé** : `Not logged in · Please run /login`, sans
appel modèle. Piège de format : ce message arrive avec `subtype:"success"` **et** `is_error:true` ; le
normaliseur traite `is_error` comme faisant foi (test dédié).

## 4. Constats

1. **Racine bwrap inscriptible.** Sans `--remount-ro /`, la racine tmpfs créée par bwrap accepte des écritures
   dans `/etc`, `/opt`, `/` (éphémères, pas sur l'hôte, mais hors politique). Corrigé dans le profil et couvert
   par un test de non-régression.
2. **Masquage `.env`** par bind de `/dev/null` en lecture seule : lecture `EACCES` (montage `nodev`), écriture
   refusée. Limite : le masquage est calculé **au démarrage** ; un fichier protégé créé ensuite par l'agent
   dans le workspace n'est pas masqué (il a été créé par l'agent, donc ne contient pas de secret hôte, mais un
   secret copié plus tard par l'utilisateur le serait).
3. **Dilemme des CLI à connexion fournisseur.** Pour fonctionner, Claude a besoin de sa session de connexion.
   La monter dans le sandbox la rend lisible par les outils de l'agent lui-même (ex. outil Bash). Ce point ne
   peut pas être tranché par le spike : décision propriétaire requise (§7, D-1).
4. **`total_cost_usd`** est présent même sous abonnement (`apiKeySource:"none"`) : ce n'est pas un montant
   facturé. Le contrat `AgentEvent.usage` ne permet pas de distinguer ce cas ; le spike ne le propage pas.
5. **Le format du flux évolue** (2.1.291 → 2.1.296 dans la journée ; nombreux champs non documentés). Le
   connecteur T-007 doit garder un traitement « inconnu = ignoré et compté » et des fixtures par version.
6. **Deux Node coexistent** (`/usr/bin/node` v18, nvm v24). Le runner doit monter un binaire explicite
   (le spike le monte en `/opt/nexus/node`) et ne jamais dépendre du `PATH`.
7. **Le groupe de processus n'est pas une frontière d'arrêt** (relevé par Hermes). `kill(-pgid)` ne touche pas
   un descendant qui a changé de session (`setsid`). Correctif : la commande est lancée dans un PID namespace
   dédié (`unshare --user --map-current-user --pid --fork --kill-child=SIGKILL`). Aucun processus ne peut
   quitter un PID namespace ; quand son PID 1 meurt, le noyau tue tout le namespace ; si `unshare` est tué,
   même par SIGKILL, `--kill-child` tue le PID 1. Les preuves reposent sur l'arrêt d'un battement écrit par le
   descendant, pas sur des PID (un PID de namespace n'est pas un PID hôte). bwrap fonctionne imbriqué dans ce
   namespace (vérifié). Le cgroup v2 délégué est aussi disponible (`systemd-run --user --scope`,
   `cgroup.kill` présent) mais n'est pas utilisé par le spike : il est recommandé pour les limites de ressources (T-014).

## 5. Décision proposée

1. **Backend Linux du runner : bubblewrap système (`/usr/bin/bwrap`)**, piloté par un profil généré
   (cf. `spikes/t001/lib/bwrap-profile.mjs`) :
   `--unshare-all --die-with-parent --new-session --clearenv`, `/usr` en lecture seule, sous-ensemble minimal
   de `/etc`, `/proc` et `/dev` privés, `/tmp` et `/home/agent` en tmpfs, worktree de la tâche seul monté en
   écriture sur `/workspace`, fichiers protégés masqués, binaires nécessaires montés explicitement en lecture
   seule, puis `--remount-ro /`.
2. **Réseau : aucun par défaut.** Liste blanche uniquement via proxy `CONNECT` hôte sur socket Unix monté,
   allowlist exacte `hôte:port`, journal de chaque décision.
3. **Sonde obligatoire au démarrage** (`probeBwrap`) : si bwrap est absent ou ne peut pas créer les namespaces
   (ex. politique AppArmor), les modes `sandbox-auto` et toute exécution autonome sont **refusés** ; seuls
   `manual` et la lecture restent disponibles, avec avertissement explicite.
4. **Exécution de processus :** binaire absolu, tableau d'arguments, `shell:false`, env construit (jamais
   hérité), timeout, annulation SIGTERM → SIGKILL, redaction. **Frontière d'arrêt : PID namespace dédié par
   exécution** (constat 7) ; le groupe de processus seul est interdit pour une exécution d'agent. Si `unshare`
   ne peut pas créer le namespace (`probeKillBoundary`), l'exécution est refusée.
5. **Streaming Claude :** `--print --output-format stream-json --verbose`, découpage borné, normalisation
   tolérante (inconnu ignoré et compté), `is_error` prioritaire sur `subtype`, absence de `result` = échec.
6. **La politique de chemins côté broker est conservée en défense en profondeur**, jamais comme barrière.

## 6. Alternatives rejetées

| Alternative | Raison |
|---|---|
| Docker rootful | Le démon tourne en root ; l'appartenance au groupe `docker` équivaut à root sur l'hôte. Contraire au moindre privilège. Non testé davantage volontairement. |
| Docker rootless / Podman rootless | **Non évalué** : rootless non configuré, Podman absent ; leur mise en place exige une installation/configuration soumise à validation. Reste une option à réévaluer (T-014) si bwrap s'avère insuffisant (images reproductibles, cgroups). |
| Sandbox Electron | N'isole pas les processus CLI (§7 du cahier maître). |
| Permissions internes du CLI (`--permission-mode`, listes d'outils) | Politique applicative, pas une barrière OS (§12). Utile en complément seulement. |
| Filtrage de chemins ou de commandes seul | Contournable (reformulation, symlinks, interpréteurs) ; démontré inutile comme barrière par UC-09. |

## 7. Décisions et approbations demandées

- **D-1 (propriétaire, bloquant pour l'exécution sandboxée réelle de Claude) — identifiants des CLI à connexion fournisseur :**
  - (a) monter la session du CLI en lecture seule dans le sandbox, réseau limité aux domaines du fournisseur
    via le proxy : fonctionnel, mais l'agent peut lire son propre jeton (exfiltration bornée aux domaines
    allowlistés) ;
  - (b) laisser le processus CLI hors du sandbox Nexus et ne confiner que ses outils (mécanisme du CLI) :
    contraire à « la politique du CLI n'est pas une barrière » si non vérifiable par Nexus ;
  - (c) pour les connecteurs API : clé injectée par le proxy hôte (en-tête ajouté hors sandbox), le jeton
    n'entre jamais dans le sandbox. Faisabilité pour les CLI à abonnement **non établie** et à vérifier contre
    les conditions du fournisseur.
  - Recommandation : (c) pour toute connexion par clé API ; (a) seulement après acceptation explicite du risque
    résiduel, avec allowlist réseau stricte ; sinon `manual` uniquement.
- **D-2 (architecte) — TRANCHÉE le 10/10/2026 :** bubblewrap est accepté comme backend Linux de référence
  **expérimental**. Il ne doit pas être présenté comme « sandbox disponible » ni activer `sandbox-auto`.
- **D-3 (architecte) — TRANCHÉE le 10/10/2026 :** propositions acceptées comme backlog futur ; aucun contrat
  n'est modifié dans T-001. Propositions :
  - `AgentEvent.usage` : distinguer un coût indicatif d'abonnement d'un coût facturé (ex. `source:'estimated'`
    avec `caveat`), ou ne pas exposer `usd` dans ce cas ;
  - `AgentEvent.failed.code` : énumération initiale `cli_reported_error`, `stream_ended_without_result`,
    `spawn_failed`, `timeout`, `cancelled`, `sandbox_unavailable` ;
  - nouveau contrat `SandboxProfile` (workspace, montages ro, masquage, réseau `none|proxy` + allowlist, env
    allowlisté, limites) consommé par le runner et le policy engine.
- **D-4 (propriétaire)** — `.env.*` (y compris `.env.example`) protégé par défaut ; exception déclarée par projet.

## 8. Risques résiduels (à traiter en T-014/T-015 avant tout « sandbox disponible »)

- **Pas de filtre seccomp** (`Seccomp: 0`) : la surface noyau reste entière ; les failles de user namespaces
  sont une classe de risque connue.
- **Aucune limite de ressources testée** (mémoire, CPU, nombre de processus, disque du workspace) : à ajouter
  via cgroups (`systemd-run --user --scope`) ou `prlimit`, puis tester (fork bomb, remplissage disque).
- **Masquage calculé au démarrage** (constat 2) ; le scanner ignore `.git` et est borné en taille.
- **Allowlist par nom d'hôte sans inspection TLS** : un domaine autorisé reste un canal d'exfiltration
  potentiel (y compris l'API du fournisseur). Résolution DNS faite par l'hôte, à durcir (IP privées interdites).
- **`/usr` entièrement lisible** : ne contient normalement pas de secret, mais un audit des chemins montés
  (`/usr/local`, `/etc/ssl` privés) est requis.
- **Dépendance à la politique AppArmor/noyau de la distribution** : la sonde doit être relancée à chaque
  démarrage et après mise à jour système.
- **Redaction par flux brut (`onChunk`)** : un secret coupé entre deux chunks n'est pas masqué ; seule la
  redaction par ligne est prouvée. La redaction ne remplace jamais l'isolation.
- **La frontière PID namespace ne limite pas les ressources** (fork bomb, mémoire) : cgroup v2 requis (T-014).
  Elle dépend aussi des user namespaces non privilégiés et de la politique AppArmor, comme bwrap.
- **Durée d'annulation d'une exécution bwrap ≈ délai de grâce** (≈1,5 s observé avec la valeur par défaut) :
  pour respecter NFR-005, le délai de grâce doit rester ≤ 2 s.
- **Codex, Gemini, Hermes non testés** ; **Windows et macOS non traités**.

## 9. Conditions go / no-go

**GO pour T-002 (bootstrap Electron Forge)**, qui ne dépend que de la direction runtime, sous conditions :
1. D-2 accepté par l'architecte (fait le 10/10/2026, à titre expérimental) et correctif de la révision 2 relu par Hermes ;
2. compatibilité Node v24.18.0 ↔ versions Forge/Electron vérifiée avant tout verrouillage (T-000) —
   **partiellement satisfaite** : le préflight npm de T-000 (Hermes, `docs/runbooks/environment.md`) relève
   des moteurs déclarés compatibles (create-electron-app 8.0.1 : Node ≥22.13.0 ; Electron 44.7.0 : ≥22.12.0 ;
   Vite 8.3.4 : ≥22.12.0). Reste à confirmer à l'installation réelle de T-002 : dépendances transitives,
   lockfile unique, et ABI des modules natifs (ex. `better-sqlite3`) compilés contre Electron 44, pas contre Node 24 ;
3. le runner reste un processus distinct de Electron main ; aucun code agent dans le renderer.

**NO-GO pour activer `sandbox-auto` ou annoncer « sandbox disponible »** tant que :
1. D-1 n'est pas tranché ;
2. seccomp, limites de ressources et masquage dynamique ne sont pas implémentés et testés (T-014) ;
3. le coffre et le broker de secrets ne sont pas prouvés (T-015) ;
4. les tests adversariaux (prompt injection, exfiltration, substitution de binaire) ne passent pas.

## 10. Retour arrière

Le spike n'ajoute ni dépendance, ni fichier de configuration racine, ni contrat. Retour arrière :
supprimer `spikes/t001/`, `tests/security/t001/` et ce fichier, ou abandonner la branche `feat/security-T-001`.
Les tests nettoient leurs répertoires temporaires. Après la suite complète, y compris les scénarios `setsid`,
aucun processus résiduel n'a été observé (`pgrep` après expiration du garde-fou de 8 s des fixtures). Cette
observation vaut pour les scénarios testés, pas comme garantie générale.

## Addendum (16/10/2026) — Frontière d'arrêt multiplateforme et mort du parent

La frontière par défaut de `runProcess` dépend désormais de la plateforme (`defaultKillBoundary`) :

| Plateforme | Frontière | Arrêt | Mort brutale de Nexus |
| --- | --- | --- | --- |
| Linux | `pid-namespace` (inchangé, strict) | SIGTERM → SIGKILL au groupe ; le noyau tue le namespace | `setpriv --pdeathsig KILL` devant `unshare` : le noyau tue unshare, `--kill-child` tue le namespace |
| macOS | `process-group` | `kill(-pgid)` SIGTERM → SIGKILL | non protégée |
| Windows | `process-tree` | `%SystemRoot%\System32\taskkill.exe /PID <pid> /T` puis `/T /F` (sans shell) | non protégée |

- Linux reste strict : sans `unshare` utilisable, l'exécution est refusée (`kill_boundary_unavailable`), pas
  dégradée en groupe de processus (constat 7). `unshare` et `setpriv` sont cherchés dans les dossiers système
  (`/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, `/run/current-system/sw/bin`) puis dans les entrées absolues du PATH
  (exécutable modifiable par tous refusé). Sans `setpriv`, la frontière reste entière mais la mort du parent n'est
  pas couverte (`probeKillBoundary().parentDeath === false`). Fenêtre résiduelle : si Nexus meurt entre le `fork`
  et le `prctl` de setpriv, le signal n'est pas armé.
- macOS et Windows : frontières plus faibles, acceptées faute de mieux. Un descendant `setsid` échappe au groupe
  (macOS) ; un descendant dont le parent est déjà terminé n'est plus rattaché à l'arbre (Windows). Correctifs
  possibles, non implémentés : Job Object `KILL_ON_JOB_CLOSE` (Windows, code natif), surveillance de `getppid`
  par une enveloppe (macOS). Ces deux plateformes n'ont pas été vérifiées sur machine réelle.
