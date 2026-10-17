# Décisions, hiérarchie des sources et définition du MVP

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

## Hiérarchie
1. Sécurité vérifiée, conditions officielles des fournisseurs et lois applicables (contraintes non négociables).
2. Décisions explicites les plus récentes de l'utilisateur : sandbox dès MVP ; GitHub/Vercel/voix ; persistance ; open source ; Ubuntu pour démarrer ; produit codage.
3. `SOURCES_ORIGINALES/Nexus_AI_SPEC_MASTER_v1.md` et exigences numérotées.
4. ADR adoptées dans le dépôt applicatif ; les ADR ne peuvent pas abolir un souhait explicite sans signaler la divergence.
5. Exemples et hypothèses de réalisation.

## Périmètre et jalons
**POC privé** = expérience limitée, peut ne pas disposer de fonctionnalités MVP MAIS doit être étiqueté non sécurisé si sandbox absent ; ne jamais donner accès aux vrais secrets.
**MVP public** = fonctionnalités `FR-001` à `FR-025` en totalité OU document explicite de changement de périmètre validé par propriétaire. Sandbox réel et protection des secrets obligatoires. Si Windows/macOS non sûrs, publier une préversion Linux seulement, sans la présenter comme la release cross-platform.
**Post MVP** = Conseil IA multi-options, nouveaux hébergeurs, collaboration humaine distante.

## Arbitrages introduits
- Electron Forge + Vite TypeScript officiel, React ajouté séparément ; aucun gros clone.
- Apache-2.0 recommandée : autorise la monétisation ET les forks commerciaux. Une stratégie SaaS, support et marque ne doit pas être décrite comme garantie de revenus.
- Pair-à-pair borné par permissions et conservation de la maîtrise du plan ; superviseur garde la responsabilité des nouvelles tâches et décisions sensibles.
- Git push confirmé, production Vercel confirmée séparément ; sandbox-auto ne doit pas permettre d'échapper au confinement.
- Sessions locales persistantes même après fermeture ; **ne pas promettre qu'un CLI survit au redémarrage de l'OS**.
