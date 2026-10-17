# Connecteurs : matrice, détection, compatibilité

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

## CLI MVP prioritaires
| Famille | Première méthode | Ordre | Contraintes |
|---|---|---|---|
| Claude Code | `claude` avec mode non interactif et flux structurés si supportés | prioritaire | vérifier version, auth, termes, consentement |
| Codex | `codex` en mode exec structuré si supporté | prioritaire | vérifier invocation, reprise, profil, limites |
| Gemini CLI | `gemini` | après contrats | format/version et auth à tester |
| Hermes | binaire/commande réelle à identifier | après contrats | **ne pas inventer commande ou format** |
| OpenCode | `opencode` | extension | explorer CLI officiel et auth |
| Qwen Code | commande réelle à identifier | extension | compatibilité versionnée |

## API
OpenAI / Anthropic / Google AI Studio / OpenRouter / Ollama ou autre modèle local. Chaque connecteur annonce capacités, modes d'auth, limitation, streaming, prix s'ils sont disponibles via une source fiable ; absence de valeur = `unavailable`.

## Probe
1. Identifier commandes sur PATH (et emplacements standards uniquement si permission explicite).
2. `--version` ou signature déclarée en `spawn(shell:false)` avec délai court.
3. Lire état d'auth *sans parcourir répertoires de credentials privés* ; si API non documentée, retourner `unknown`.
4. Contrôler permissions du binaire, signature si pertinente ; aucun auto-login.
5. Demander à l'utilisateur de sélectionner le profil et les capacités à accorder ; pas d'enregistrement automatique des mots de passe.

## Limites d'abonnement
Aucun système n'est autorisé à extraire des cookies de navigateur, simuler des requêtes cachées, contourner limites ou réutiliser des jetons en violation des conditions. Les CLI sont utilisés selon les intégrations autorisées.
