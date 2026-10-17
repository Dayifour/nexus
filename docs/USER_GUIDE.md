# Guide d'utilisation — Nexus AI 0.1

Nexus AI est un atelier local pour vos agents de code. **Ce sont les CLI des agents (Claude Code, Codex, Gemini CLI,
Qwen Code, OpenCode, Hermes) qui codent, avec leurs propres outils, modèles et abonnements. Nexus ne les remplace
jamais** : il les lance, les isole, les orchestre, relaie leurs messages, relit leurs résultats et les intègre à votre
projet quand vous le confirmez.

> État réel : Linux est la seule plateforme vérifiée. Les versions Windows et macOS sont expérimentales (pas de sandbox,
> comportement des processus et des terminaux non vérifié sur de vraies machines). Gemini CLI et Qwen Code n'ont jamais été
> lancés en réel. Détail : `.coordination/STATUS.md`.

## 1. Installer

| Système | Commande |
|---|---|
| Ubuntu / Debian | `sudo apt install ./nexus-ai_<version>_amd64.deb` |
| Autre Linux | dézipper `Nexus AI-linux-x64-<version>.zip`, lancer `nexus-ai` |
| Windows / macOS | expérimental : installateur `.exe` / `.zip` (macOS non signé : clic droit → Ouvrir) |

Pour le mode sandbox (Linux) : `sudo apt install bubblewrap socat`. Depuis les sources : `docs/runbooks/installation.md`.

Au premier lancement, la langue suit celle du système (modifiable ensuite dans les Réglages).

## 2. Connecter les agents

Nexus détecte les CLI déjà installées dans le `PATH`. Sans agent, l'écran d'accueil propose les commandes d'installation :

| Agent | Installation | Connexion (une fois, dans un terminal) | Vérifié en réel |
|---|---|---|---|
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `claude` | oui |
| Codex CLI | `npm install -g @openai/codex` | `codex login` | oui |
| OpenCode | `npm install -g opencode-ai` | `opencode auth login` | oui |
| Hermes | script d'installation de NousResearch | `hermes setup` | oui |
| Gemini CLI | `npm install -g @google/gemini-cli` | `gemini` | non |
| Qwen Code | `npm install -g @qwen-code/qwen-code` | `qwen` | non |

Après installation : **Rescanner** (écran d'accueil) ou **Réglages → Relancer la détection**. Nexus revérifie aussi
quand la fenêtre reprend le focus. Nexus ne lit jamais vos fichiers de connexion : « connecté » n'est confirmé qu'au
premier lancement réel.

Connecteurs API (OpenAI, Anthropic, Google, OpenRouter) : clé stockée dans le trousseau du système. Ils ne font que de la
conversation (aucun outil, aucune modification de fichier) et n'ont pas été vérifiés avec de vraies clés.

## 3. Ouvrir un projet

**Ctrl+O** (ou glisser-déposer un dossier). Les modes Avec validation et Sandbox, ainsi que l'Orchestre, travaillent sur
une copie Git : le projet doit être un dépôt Git (`git init` puis un premier commit).

## 4. Les trois modes

| Mode | Où l'agent écrit | Ce qui est réellement isolé |
|---|---|---|
| **Avec validation** (par défaut) | une copie Git (worktree) du projet | votre dossier n'est modifié qu'après acceptation du diff ; l'agent garde par contre l'accès normal à votre machine (fichiers, réseau) |
| **Autonome** | directement dans votre projet | rien, hormis la frontière de processus (l'arrêt tue tout l'arbre de l'agent) |
| **Autonome en sandbox** (à activer, Linux seulement) | une copie Git, dans bubblewrap | seul le dossier de travail est visible ; HOME, clés SSH, `.npmrc`, `.git-credentials` masqués ; seccomp ; pas de réseau direct, un proxy n'autorise que les domaines du fournisseur de l'agent |

Points à connaître sur la sandbox :

- **La connexion de l'agent est montée en lecture-écriture** (ex. `~/.claude`, `~/.codex`, `~/.config/opencode`) : sans
  cela, la CLI ne fonctionne pas. L'agent peut donc lire et modifier sa propre session.
- **Les fichiers `.env` du projet sont visibles par l'agent** par défaut (décision D-4). Ne mettez pas de secrets de
  production dans un projet confié à un agent.
- Les métadonnées Git (`.git`) sont en **lecture seule** ; Git s'exécute sur l'hôte, qui refuse un dépôt dont la
  configuration définit des commandes (filtres, `sshCommand`…). Le push refuse aussi une configuration locale de ce type.
- Un domaine refusé par le proxy s'affiche avec un bouton **Autoriser ce domaine**.
- La messagerie entre agents de l'Orchestre n'est pas disponible en sandbox.

Le mode par défaut se règle dans **Réglages → Mode par défaut des sessions**.

## 5. Sessions

**Ctrl+Shift+N** : nouvelle session. Choisir l'agent, le mode, écrire la consigne.

- Affichage **terminal** (la vraie interface de l'agent, saisie directe) ou **conversation**.
- Composer : **Entrée** envoie, **Maj+Entrée** va à la ligne ; un message écrit pendant que l'agent travaille est mis
  en file et envoyé au tour suivant.
- **Changements** : diff de la copie ; accepter (fusion dans le projet) ou demander des corrections.
- **Terminal ici** ouvre un terminal dans le dossier de la session.
- Les sessions sont conservées par projet, reprenables, supprimables. Fermer le terminal d'un agent actif demande confirmation.
- Notifications système cliquables quand un agent attend ou a fini (si la fenêtre n'a pas le focus).

## 6. Diffuser à plusieurs agents

Dans la nouvelle session, **Comparer plusieurs agents** : la même consigne part à 2–6 agents, chacun dans sa propre copie.
Vous comparez les diffs et n'acceptez que celui qui vous convient. Indisponible en mode Autonome (ils écriraient tous dans
le même dossier).

## 7. Orchestre, pas à pas

1. **Lancer un orchestre** (vue Orchestres) : écrire l'objectif.
2. Choisir le **chef d'orchestre** : il planifie et relit **en lecture seule** (Claude, Codex ; Gemini/Qwen via
   `--approval-mode plan`, OpenCode via `--agent plan`, Hermes avec des outils sans écriture ni terminal et toute écriture
   de fichier refusée).
3. Choisir les **agents de l'équipe** (6 au maximum), le mode (copie isolée par défaut) et l'**autonomie** : *Totale* ou
   *Je valide le plan*.
4. Le chef découpe l'objectif en tâches avec dépendances (DAG). Les tâches indépendantes tournent **en parallèle dans une
   copie commune isolée**. Chaque agent reçoit le rapport et les changements des tâches dont il dépend.
5. Pendant le travail, les agents (Claude, Codex, Gemini, Qwen, OpenCode, Hermes) se parlent par le bus MCP `nexus` :
   `team_status`, `send_message`, `read_messages`, `ask_lead`. Vous pouvez aussi écrire au chef à tout moment.
6. Le chef **relit** chaque résultat (diff + critères) : accepté ou renvoyé avec des corrections précises. Un agent qui
   échoue (non connecté, erreur) voit ses tâches réattribuées, avec la raison affichée.
7. **Intégrer au projet** : fusion de la copie dans votre projet, après confirmation. **Terminal dans la copie** pour
   inspecter avant.
8. **Arrêter** stoppe cet orchestre seulement. Après un redémarrage de Nexus, un orchestre interrompu propose **Reprendre**.

## 8. Pull request

Vue **Contrôle de source** (Ctrl+Shift+G) : commit, push, puis création de PR via la CLI `gh` (à installer et connecter :
`gh auth login`). Push et PR passent par un dialogue de confirmation ; jamais de force-push. Vérifié seulement contre une
fausse CLI `gh` à ce jour.

## 9. Déploiement

Vue **Déploiement** : Nexus analyse le projet, l'IA propose des architectures (Vercel, Render, Railway, VPS Hostinger,
MongoDB Atlas), vous en choisissez une, puis chaque étape s'exécute **après votre confirmation**. Jetons des hébergeurs
dans le trousseau du système ; empreinte SSH du VPS vérifiée. Vérifié seulement contre des API simulées.

## 10. Consommation, dictée, thème, langue

- **Consommation** : quotas et usage par agent ; « indisponible » quand le fournisseur ne le dit pas (jamais de chiffre inventé).
- **Dictée** : exige whisper.cpp installé localement ou un consentement explicite au service cloud ; jamais testée en réel.
- **Réglages** (Ctrl+,) : thème clair / sombre / système, langue français / anglais (interface, messages et journaux).

## 11. Raccourcis (Ctrl = ⌘ sur macOS)

| Action | Raccourci |
|---|---|
| Palette de commandes | Ctrl+Shift+P (ou F1 dans l'éditeur) |
| Ouvrir un fichier | Ctrl+P |
| Ouvrir un dossier | Ctrl+O |
| Nouvelle session | Ctrl+Shift+N |
| Explorateur / Recherche / Git / Agents | Ctrl+Shift+E / F / G / D |
| Barre latérale / panneau du bas | Ctrl+B / Ctrl+J (ou Ctrl+`) |
| Agrandir le panneau | Ctrl+Shift+M |
| Nouveau terminal / scinder | Ctrl+Shift+` / Ctrl+Shift+5 |
| Copier / coller dans le terminal | Ctrl+Shift+C / Ctrl+Shift+V |
| Enregistrer / tout enregistrer | Ctrl+S / Ctrl+Alt+S |
| Nouveau fichier / fermer l'onglet / rouvrir | Ctrl+N / Ctrl+W / Ctrl+Shift+T |
| Onglet suivant / précédent | Ctrl+PgDn / Ctrl+PgUp (Ctrl+Tab : récents) |
| Aller à l'onglet n / au groupe n | Alt+n / Ctrl+n |
| Scinder l'éditeur | Ctrl+\ |
| Renommer / supprimer (explorateur) | F2 / Suppr |
| Mode zen | Ctrl+K Z |
| Liste des raccourcis | Ctrl+K Ctrl+S |
| Réglages | Ctrl+, |

Fermer un onglet modifié non enregistré demande confirmation.

## 12. Dépannage

**La sandbox est « indisponible » (Ubuntu 24.04 et plus)** — AppArmor interdit les user namespaces non privilégiés :

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
# permanent :
echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-nexus-userns.conf
```

Vérifier aussi `bwrap` et `socat` : `sudo apt install bubblewrap socat`. Le même réglage est nécessaire pour la frontière
de processus (PID namespace) : sans lui, Nexus refuse de lancer un agent plutôt que de le lancer sans contrôle.

**Agent non détecté** — vérifier `which <cli>` dans un terminal, puis **Rescanner**. Un binaire modifiable par tous les
utilisateurs, ou introuvable par chemin absolu, est volontairement ignoré.

**L'agent démarre puis s'arrête** — il n'est probablement pas connecté : lancez sa commande de connexion dans un terminal.

**« Initialisez d'abord un dépôt Git »** — les modes isolés et l'Orchestre ont besoin d'un dépôt Git avec au moins un commit.

**Domaine bloqué en sandbox** — cliquer **Autoriser ce domaine** ou l'ajouter dans les Réglages.

**PR impossible** — installer `gh` et lancer `gh auth login`.

Données locales et journaux : voir `docs/runbooks/installation.md`.
