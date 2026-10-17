# Matrice de permissions initiale à implémenter

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

| Action | Manual | Notify | Sandbox-auto | Contrôle invariant |
|---|---|---|---|---|
| Lecture de code monté et non secret | Autorisé | Autorisé | Autorisé | chemin dans allowlist |
| Modifier fichiers du worktree | Après assignation | Notification configurable | Automatique confiné | journal + diff |
| Exécuter tests/build locaux | Validation selon niveau | Notification | Automatique si allowlist | sandbox/ressources |
| Installer dépendance du réseau | Confirmation | Confirmation | Confirmation selon politique | egress contrôlé |
| Lire `.env`/credentials/SSH | Interdit au CLI générique | Interdit | Interdit | secret broker uniquement |
| Push GitHub | Confirmation | Confirmation | Confirmation | aperçu destination/commits |
| Force push/suppression repo | Refus par défaut | Refus par défaut | Refus par défaut | déverrouillage spécifique hors MVP |
| Déployer preview Vercel | Consentement | Consentement | Consentement selon politique | aucun token au CLI générique |
| Déployer production | Confirmation spécifique | Confirmation spécifique | Confirmation spécifique | approbation toujours distincte |
| Suppression hors workspace | Interdit | Interdit | Interdit | isolation OS |

Vérifier également exfiltration indirecte via terminal, réseau, logs, artefacts et fichiers Git ; la redaction de chaînes n'est jamais une preuve d'isolation.
