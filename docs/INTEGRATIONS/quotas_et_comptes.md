# Quotas Et Comptes

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

**Source :** chapitres 16 de `SOURCES_ORIGINALES/Nexus_AI_SPEC_MASTER_v1.md`. Ce fichier est une extraction documentaire, sans remplacement du maître.

## Chapitre 16 — Monitoring de consommation et budget

**Trois classes :** `reported` (fournisseur/CLI officiel), `estimated` (calcul local transparent), `unavailable`. Afficher horodatage, unité, période de réinitialisation *si fournie*, source et marge d'incertitude. Ne pas manipuler les endpoints privés/non documentés pour contourner les limites ni supposer les quotas d'abonnements équivalents aux crédits API. Budget par agent/projet, alerte avant seuil, stop à dépassement si calcul fiable ; sinon politiques conservatrices (temps/tours/tâches). Diagnostics anonymisables.
