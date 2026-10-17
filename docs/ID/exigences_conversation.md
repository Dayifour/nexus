# Inventaire exhaustif des décisions et intentions exprimées

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

Ce fichier restitue toutes les exigences métier identifiées dans les échanges disponibles, sans affirmer reproduire mot pour mot chaque phrase. Référence détaillée : `SOURCES_ORIGINALES/Nexus_AI_SPEC_MASTER_v1.md`.

## Vision
- Produit principalement destiné au **codage et aux agents de programmation**, pas une plateforme IA généraliste.
- Application desktop autonome et open source, développée initialement sous Ubuntu, distribuée ensuite sur Ubuntu/Linux, Windows et macOS.
- Moteur d'assignation conçu sur mesure en TypeScript ; **boilerplate léger**, pas clone d'un concurrent.
- Le projet final est commercialisable ultérieurement, tout en laissant le cœur open source ; licence Apache-2.0 recommandée, non synonyme d'exclusivité commerciale.
- Nom « Nexus AI » provisoire.

## Connexions et comptes
- Connecteurs API : OpenAI, Anthropic, Google AI Studio, OpenRouter, autres fournisseurs et modèles locaux à terme.
- Connecteurs CLI : Claude Code, Codex, Gemini CLI, Hermes, OpenCode, Qwen Code et architecture extensible pour de nouveaux CLI.
- Détecter automatiquement les CLI préexistants à l'installation ou au premier lancement ; afficher version, état, capacité, authentification si accessible légalement.
- Plusieurs comptes/profils d'un même fournisseur, sous réserve des autorisations et restrictions.
- Utiliser les abonnements existants uniquement via leurs canaux officiellement permis ; **aucun contournement** des protections ou quotas. ChatGPT Plus/Pro ≠ clés API OpenAI ; abonnement Claude ≠ API Anthropic.
- Afficher taux d'utilisation, consommation, restant, fenêtre de réinitialisation et coût quand disponibles ; sinon afficher estimation ou indisponible, provenance/horodatage.

## Équipes et conduite des agents
- Plusieurs projets, plusieurs équipes par utilisateur, rôle par agent ; chacun peut ouvrir un projet et restaurer son contexte.
- Trois gouvernances : humain manuel ; IA « cerveau principal » choisie par utilisateur ; assisté (IA planifie, humain approuve).
- Routage selon capacité, coût, disponibilité, contraintes, préférences et budget ; forçage manuel toujours possible.
- Plusieurs tâches exécutées simultanément si sûres ; communication inter-agents et mémoire commune ; discussion/consultation directes possibles selon droits et limites.
- Débat / conseil IA activable par l'utilisateur, jamais imposé.
- Historique visible des conversations, décisions, actions et contributions de chaque agent ; audit, recherches, révisions, stop et reprise.
- Conserver discussions et tâches à fermeture du navigateur/Explorer, de l'interface et même au redémarrage de l'application ; restauration d'état et reprise de session native quand prise en charge.

## Éditeur et développeur
- Application de type coding-agent avec espace pour fichiers/code/éditeur, terminaux, diff, tâches, dashboard et contextes de travail.
- Plan de développement en phases, diagrammes d'architecture, schémas structurels, documentation et aide à l'hébergement.
- Git, branches, worktrees, commits, push GitHub et PR avec revue et confirmation.
- Intégration Vercel dans MVP pour preview et éventuellement publication production **après confirmation** ; autres hébergeurs ultérieurs.
- Dictée/voice input : micro sur consentement, transcription corrigible avant soumission.

## Sécurité
- Sandbox **dès le MVP public** ; mode manuel, notification ou exécution automatique confinée au choix de l'utilisateur. Les secrets restent inaccessibles aux agents génériques même en mode automatique.
- Variables `.env`, tokens, clés, credentials, SSH, fichiers personnels protégés via absence de montage / capacités OS réelles, pas uniquement filtres sur prompts.
- Notifications configurables des actions sensibles, règles d'approbation suivant le risque, journal d'audit et révocation des permissions.
- Sécurité des processus CLI indépendamment du sandbox renderer Electron ; Git push, suppression massive, production et dépenses élevées sont des points de contrôle.

## Premier démonstrateur
- Une petite application de gestion de stock (auth, produits, fournisseurs, entrées/sorties, tests, visualisation, déploiement preview éventuel) **comme projet test produit par les agents**, et non comme fonction métier centrale de Nexus AI.
- Premier jalon : détecter deux CLI, assigner, exécuter de manière isolée, observer, partager résultats, restaurer session et valider les diffs.
