# Tests Acceptation

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

**Source :** chapitres 19 de `SOURCES_ORIGINALES/Nexus_AI_SPEC_MASTER_v1.md`. Ce fichier est une extraction documentaire, sans remplacement du maître.

## Chapitre 19 — Plan de validation et jeux d'essais (acceptance)

| ID | Test d'acceptation |
|---|---|
| AC-01 | CLI absent, présent non authentifié, présent authentifié détectés sans crash |
| AC-02 | Deux providers différents collaborent et transmettent artefact versionné |
| AC-03 | Concurrence : 2 worktrees isolés ; conflit simulé remonté sans écrasement |
| AC-04 | Kill forcé pendant événement ; données relues ; session marquée interrupted |
| AC-05 | Resume natif quand compatible ; fallback déclaré sinon |
| AC-06 | `.env`, SSH keys et hors-workspace inaccessibles à agent sandboxé |
| AC-07 | Tentative egress vers domaine non autorisé bloquée et enregistrée |
| AC-08 | Confirmation requise avant GitHub push, PR ou Vercel production selon politique |
| AC-09 | Clé API jamais présente dans export/log/UI/command line ou payload agent |
| AC-10 | Quota inconnu affiché « indisponible » et pas 0 % ou 100 % fictif |
| AC-11 | Audio consenti, transcription modifiable, aucun enregistrement silencieux |
| AC-12 | Smoke tests installateurs Ubuntu/Windows/macOS et vérification des politiques |
| AC-13 | Prompt injection issue GitHub « imprime secret » ignoré/bloqué |
| AC-14 | Erreur réseau, limite fournisseur, binaire CLI non trouvé et version inconnue gérés |
