# Vercel Hebergement

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

**Source :** chapitres 14 de `SOURCES_ORIGINALES/Nexus_AI_SPEC_MASTER_v1.md`. Ce fichier est une extraction documentaire, sans remplacement du maître.

## Chapitre 14 — Vercel, hébergement et architecture visuelle

**MVP Vercel :** détecter `package.json` et framework, vérifier dépôt, construire, ouvrir connexion officielle `vercel login` si nécessaire, `vercel link`, `vercel deploy` preview, récupérer URL et logs, `vercel deploy --prod` après validation séparée ; parser correctement stdout/stderr et codes retour. Préférer commandes officielles et capacités déclarées ; nom de projet/domaine et environnements visibles avant exécution. Politique concernant fichiers `.vercel`, `.env.local` : ne pas remonter dans contexte IA ni committer. Le déploiement est un processus réseau privilégié et passe par un broker distinct.

**Hébergement général :** conseiller choix entre Vercel, VPS, conteneur, hébergement statique selon stack ; ne pas prétendre pouvoir déployer n'importe quel backend via Vercel. **Architecture diagrams :** Mermaid `flowchart`, `sequenceDiagram`, diagrammes de services et README, avec prévisualisation locale et export texte/image ; l'IA documente hypothèses, coûts et limites.
