# Questions Ouvertes

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

**Source :** chapitres 26 de `SOURCES_ORIGINALES/Nexus_AI_SPEC_MASTER_v1.md`. Ce fichier est une extraction documentaire, sans remplacement du maître.

## Chapitre 26 — Risques, questions ouvertes et politique d'arbitrage

| Risque/question | Décision par défaut / responsable | État au 16/10/2026 |
|---|---|---|
| Nom Nexus AI déjà utilisé ou marque | nom provisoire ; vérification juridique avant communication publique | ouverte |
| Runtime sandbox Windows/macOS | spike par OS, ne pas livrer autonomie sans tests ; responsable sécurité | **ouverte** (16/10) : aucun backend ; le mode sandbox est refusé sur ces OS |
| Hermes CLI format/options exactes | connecteur en beta jusqu'à tests contre version réelle ; responsable intégration | **répondue** : vérifié en réel (`chat -Q -q`) ; pas de mode lecture seule, donc jamais chef d'orchestre. Hermes n'est plus co-développeur du projet depuis le 11/10/2026 |
| Voice hors ligne multi-OS et taille binaire | comparaison moteurs avant choix ; responsable voice | ouverte |
| Quotas abonnements ChatGPT/Claude | aucun accès API présumé ; vérifier conditions/documentation ; produit | ouverte |
| Modèles/modes concurrent IA évoluent | manifest capabilities/version + tests contractuels | ouverte |
| Clause open source et contributions | Apache-2.0 facilite services commerciaux mais autorise forks commerciaux ; examiner CLA/licence marque avant contributions externes | **licence décidée** : Apache-2.0 appliquée (`LICENSE`, `NOTICE`, Copyright 2026 Dayifour) ; CLA/DCO **ouvert** |
| Extension Vercel pour backend non compatible | refuser déploiement auto, expliquer alternatives | **répondue** : le plan de déploiement propose Render, Railway, VPS Hostinger ou Atlas |
| Coût et latence de 5 agents | plafond par mission, mode 2 agents recommandé par défaut | ouverte |
| Conflit entre exigences vitesse/sécurité | sécurité et protection secrets priment sur automatisation | principe appliqué |
