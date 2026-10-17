# ADR-002 — Monorepo, outillage de test, persistance Prisma + libSQL

- **Statut :** acceptée, révisée le 11/10/2026 sur consigne du propriétaire : « utilise zod, zustand, Prisma, des DTO si le
  besoin se présente au lieu d'utiliser une alternative ». La persistance passe de `node:sqlite` à Prisma (§Décision 3).
- **Tickets :** T-002 (repris), T-004, T-005.

## Contexte

Le bootstrap T-002 (Electron Forge 8.0.1, Electron 44.7.0, Vite 8.3.4, TypeScript 6.0.3, oxlint/oxfmt) est en place
dans `apps/desktop`. Il faut choisir comment structurer les packages, les tester et persister les événements, en
limitant les dépendances (chaque dépendance doit être justifiée, figée et sa licence relevée, §23).

## Mesures

| Sonde | Résultat |
|---|---|
| `require('node:sqlite')` dans Electron 44.7.0 (Node 24.21.0) | fonctionne, SQLite 3.53.4 |
| `node:sqlite` dans Node 24.18.0 (tests) | fonctionne, SQLite 3.53.1 |
| Node 24 exécute un test `.ts` important un package workspace `.ts` (type stripping, lien symbolique npm) | fonctionne |
| Client Prisma 7.10.0 généré (`importFileExtension = ts`) importé directement par Node 24 | fonctionne |
| Event store Prisma + libsql : 12 tests dont crash SIGKILL ×3 pendant l'écriture | base intègre, aucun lot partiel |

## Décision

1. **Packages TypeScript source** sous `packages/*`, `"type": "module"`, `exports` pointant vers `src/index.ts`.
   Aucune étape de compilation par package : Vite les embarque dans le main Electron ; Node les exécute directement
   pour les tests (type stripping). Contraintes : syntaxe effaçable uniquement (`erasableSyntaxOnly` : pas d'`enum`,
   de `namespace` ni de propriétés de paramètre) et imports relatifs avec extension `.ts`.
2. **Tests : `node:test` intégré**, sans Vitest. Couverture via `--experimental-test-coverage`. E2E Electron via
   Playwright (`_electron`) lors de T-003/T-017.
3. **Persistance : Prisma 7.10.0** (consigne du propriétaire), générateur `prisma-client` (TypeScript, imports `.ts`,
   compatible type stripping), **adaptateur officiel `@prisma/adapter-libsql`** sur SQLite local.
   - Pourquoi libsql et pas `@prisma/adapter-better-sqlite3` : `better-sqlite3` est un module natif lié à l'ABI V8,
     à recompiler séparément pour Electron et pour Node. Les binaires `libsql` sont précompilés sur N-API, ABI stable
     entre Node et Electron : aucune recompilation.
   - Prisma 7 n'a plus de moteur de requêtes binaire (« Query Compiler ») : rien à télécharger à l'exécution.
   - La CLI Prisma (dev uniquement) génère le client et le SQL des migrations (`prisma migrate diff`). L'application
     n'embarque pas la CLI : un migrateur maison applique au démarrage les migrations SQL embarquées, chacune dans une
     transaction, avec somme de contrôle et sauvegarde préalable de la base.
   - Le journal est protégé en ajout seul par des triggers SQLite (UPDATE/DELETE refusés).
   - Écart avec le cahier maître : aucun (§6 proposait « better-sqlite3 ou sqlite native robuste »).
4. **Contrats : Zod 4** dans `packages/contracts`, seule source des schémas et types partagés, versionnés. Ces schémas
   servent de **DTO** aux frontières (IPC, connecteurs, événements) ; les modèles Prisma ne traversent jamais l'IPC :
   le main les convertit en DTO validés.
5. **État de l'interface : Zustand** (consigne du propriétaire) dans le renderer React.
6. **Typecheck global** par `tsc --noEmit -p tsconfig.json` à la racine ; lint/format par oxlint/oxfmt (choix T-002).
7. **Un seul lockfile** (`package-lock.json`, npm).

## Alternatives rejetées

- Vitest : redondant avec `node:test` maintenant que Node exécute le TypeScript ; une dépendance de moins.
- `better-sqlite3` (avec ou sans Prisma) : module natif à recompiler pour Electron ET Node.
- `node:sqlite` seul : fonctionnait (sondé), mais remplacé par Prisma sur consigne du propriétaire.
- Compilation par package (`tsc -b`) : complexité inutile tant que seul Electron consomme les packages.

## Risques

- Empaquetage Electron : `@prisma/client`, `@libsql/*` et le binaire N-API doivent être exclus du bundle Vite et
  copiés dans le paquet (à prouver en T-003/T-024 par un démarrage de l'application empaquetée).
- La CLI Prisma 7.10.0 hérite de vulnérabilités `high` (`mysql2`, `deepmerge-ts`) : outil de développement non embarqué ;
  à réévaluer à chaque montée de version.
- `oxfmt` 0.41.0 (T-002) portait une faille critique (`tinypool`) : mis à jour en 0.72.0.
- Le type stripping de Node ignore la vérification de types : `pnpm run typecheck` est obligatoire en CI.
