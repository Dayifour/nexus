# Politique

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

**Source :** chapitres 12 de `SOURCES_ORIGINALES/Nexus_AI_SPEC_MASTER_v1.md`. Ce fichier est une extraction documentaire, sans remplacement du maître.

## Chapitre 12 — Sandbox et protection des secrets — BLOQUANT MVP

| Profil | Lecture | Écriture | Réseau | Actions sensibles |
|---|---|---|---|---|
| `read-only` | fichiers autorisés | interdite | refusé par défaut | refusées |
| `sandbox-auto` | arborescence montée autorisée | worktree de tâche | liste blanche explicite | broker et policy |
| `notify` | portée définie | portée définie | demande si nécessaire | confirmation |
| `manual` | portée définie | autorisation explicite | validation humaine | confirmation préalable |

**Architecture SEC-001 à SEC-008 :** runner OS distinct, permissions minimales, montage/worktree autorisé seulement, fichiers secrets non montés, réseau par défaut limité selon politique, exécution shell avec arguments non concaténés, détection de chemins traversants/symlinks, limitation ressources et temps, redaction des logs, contrôle egress et appels outils, tests adversariaux. La politique du CLI seul n'est pas une barrière de sécurité suffisante. Si l'isolation OS n'est pas disponible, **bloquer les actions autonomes dangereuses** au lieu de simuler une sécurité.

**Linux :** prototype runner sous conteneur rootless ou `bubblewrap` avec namespaces et bindings restrictifs, sous réserve de support kernel et de tests ; prévoir fallback *refus* si mécanisme absent. **macOS :** étudier helper signé, séparation de processus et mécanismes système pris en charge ; ne pas supposer que le sandbox Electron s'applique aux CLI. **Windows :** étudier environnement isolé/WSL2 ou conteneurs compatibles, jeton restreint et ACL ; même objectif d'isolation vérifié par tests. Détails backend par OS devront être validés avant distribution, aucune équivalence présumée.

**Secret Guard :** credentials stockés dans coffre OS si disponible (Linux Secret Service, Windows Credential Manager, macOS Keychain) via intégration testée ; chiffrement/base secrète séparée seulement si nécessité ; jamais `localStorage` UI ; jamais injection globale d'un token API dans l'environnement de tous les agents. Les connecteurs GitHub/Vercel reçoivent les identifiants via broker, sans exposer au modèle. Scanner diff avant push pour secrets connus ; refus par défaut si détection critique.

**Modèle de menace :** prompt injection depuis dépôt/issue, fichier `.env`, commandes destructrices, exfiltration par HTTP, symlinks hors sandbox, substitution de binaire PATH, extensions malveillantes, logs contenant token, scripts postinstall, erreurs de reprise, escalade agent-vers-agent. Pour chaque menace : test automatisé et procédure d'incident.

**Critère absolu :** pas de sortie MVP « sandbox disponible » tant que les tests de fuite/écriture/réseau et de confinement sur les trois OS cibles ne sont pas passés. Préversion Ubuntu interne possible avec avertissement explicite et autonomie limitée.
