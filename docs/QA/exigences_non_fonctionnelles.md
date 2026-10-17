# Exigences Non Fonctionnelles

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

**Source :** chapitres 18 de `SOURCES_ORIGINALES/Nexus_AI_SPEC_MASTER_v1.md`. Ce fichier est une extraction documentaire, sans remplacement du maître.

## Chapitre 18 — Qualité, conformité, performance (NFR)

| ID | Mesure cible initiale (à affiner par tests) |
|---|---|
| NFR-001 | Ouverture interface sous 5 s sur machine de référence déjà provisionnée |
| NFR-002 | Sauvegarde événement atomique avant accusé réception UI ; pas de corruption SQLite sous arrêt forcé |
| NFR-003 | Contrats IPC validés et journalisés, 0 accès Node direct depuis renderer |
| NFR-004 | Deux agents simultanés minimum sur machine adéquate |
| NFR-005 | Arrêt/cancel lancé sous 3 s (hors processus OS non coopératif, escalade ensuite) |
| NFR-006 | Tests unité >= 80 % sur core/policy (objectif, pas garantie de sûreté) |
| NFR-007 | Installateurs Ubuntu, Windows, macOS testés en CI et en tests manuels |
| NFR-008 | Pas d'identifiants, `.env` ou tokens en clair dans logs, exports et traces |
| NFR-009 | 100 % des push/production deploy soumis à garde d'autorisation explicite |
| NFR-010 | Paramètres, labels UI, erreurs de confiance compréhensibles en FR/EN |
