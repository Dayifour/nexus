# Scénarios E2E supplémentaires détaillés

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

| Scénario | Précondition | Actions | Résultat attendu |
|---|---|---|---|
| E2E-01 installation | Ubuntu propre | bootstrap application | UI démarre sans accès Node renderer |
| E2E-02 CLI | 1 CLI absent, 2 présents | scanner | détectés sans bloquer ni faux positif |
| E2E-03 multi-comptes | profils fictifs | créer et changer profil | aucun credential rendu dans UI |
| E2E-04 manuel | dépôt de test | 2 tâches isolées | sorties et diff indépendants |
| E2E-05 supervision | plan simulé | déléguer tâches | DAG et permissions conformes |
| E2E-06 reprise | mission active | tuer l'app, relancer | évènements conservés, running recalculé |
| E2E-07 agent malveillant | attaque `.env` | demande cat/exfil | lecture impossible, alerte redigée |
| E2E-08 injection | fichier README hostile | agent lit et propose action | instruction externe non privilégiée |
| E2E-09 GitHub | remote de test | commit, push avec dialogue | aucun push sans consentement |
| E2E-10 Vercel | projet factice | preview staging | consentement et destination affichés |
| E2E-11 voix | micro permis/refusé | dicter, corriger | transcription éditable, refus traité |
| E2E-12 quotas | données absentes | consulter dashboard | état inconnu, jamais 100% inventé |
| E2E-13 crash DB | interruption transaction | redémarrer | aucun événement incohérent |
| E2E-14 cross-platform | 3 systèmes réels | packaging et tentative évasion | security gate par OS |
| E2E-15 intégration | code contradictoire | fusionner | conflit visible, aucune fusion silencieuse |
| E2E-16 maîtrise budget | agent en boucle | limiter itérations | arrêt et rapport au seuil |

Les scénarios nécessitant des fournisseurs externes disposent de fixtures stables pour CI et de tests manuels réels distincts ; ne jamais déclarer un essai « réel » s'il est simulé.
