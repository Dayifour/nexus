# Contrats

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

**Source :** chapitres 9 de `SOURCES_ORIGINALES/Nexus_AI_SPEC_MASTER_v1.md`. Ce fichier est une extraction documentaire, sans remplacement du maître.

## Chapitre 9 — Contrat universel d'agent et de connecteur

```ts
export type AgentKind = 'cli' | 'api' | 'local';
export type Capability = 'chat'|'edit'|'terminal'|'structured-output'|'resume'|'stream'|'usage'|'tools';
export interface ConnectorManifest {
  id: string; version: string; kind: AgentKind; displayName: string;
  capabilities: Capability[];
  supportedPlatforms: Array<'linux'|'win32'|'darwin'>;
  authModes: Array<'vendor-login'|'api-key'|'local-none'>;
}
export interface AgentTaskRequest {
  taskId: string; projectId: string; sessionId: string; agentProfileId: string;
  workspacePath: string; prompt: string; contextRefs: string[];
  permissionsPolicyId: string; timeoutMs: number; budget?: { tokens?: number; currencyUsd?: number };
}
export type AgentEvent =
 | { kind:'started'; taskId:string; sequence:number; nativeSessionId?:string }
 | { kind:'output'; taskId:string; sequence:number; text:string; channel:'stdout'|'stderr'|'message' }
 | { kind:'tool-request'; taskId:string; sequence:number; tool:string; payloadRef:string }
 | { kind:'usage'; taskId:string; sequence:number; source:'reported'|'estimated'; inputTokens?:number; outputTokens?:number; usd?:number }
 | { kind:'completed'; taskId:string; sequence:number; resultRef:string }
 | { kind:'failed'; taskId:string; sequence:number; code:string; message:string };
export interface AgentConnector {
  manifest: ConnectorManifest;
  probe(): Promise<{installed:boolean; version?:string; authenticated?:boolean; reason?:string}>;
  start(req: AgentTaskRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
  resume?(nativeSessionId:string, req:AgentTaskRequest, signal:AbortSignal): AsyncIterable<AgentEvent>;
  cancel?(taskId:string): Promise<void>;
  getUsage?(): Promise<UsageSnapshot>;
}
export interface UsageSnapshot {
  observedAt:string; source:'vendor'|'cli'|'local-estimate'|'unavailable';
  remaining?:number; consumed?:number; unit?:'tokens'|'requests'|'usd'|'percent';
  windowEnd?:string; caveat?:string;
}
```

Ce code est un **contrat de référence**, pas un fichier déjà compilé. Les implémenteurs stabilisent schémas Zod, sérialisation, erreurs, idempotence et tests dans `packages/contracts` avant de créer les adaptateurs. Un connecteur annonce uniquement ce qu'il sait réellement faire ; l'absence `getUsage` est normale.

**CLI :** processus non interactifs avec sorties structurées lorsque possibles (Claude `--print --output-format stream-json`, Codex `exec --json` sous versions compatibles) ; mode PTY pour interfaces interactives ; ne jamais supposer l'identité des formats d'événements ou l'autorisation d'utiliser un abonnement via un outil tiers. `claude --resume` et `codex exec resume` sont des capacités documentées, pas des garanties d'égalité de contexte.

**API :** fournisseurs SDK officiels lorsque pertinent, limites/erreurs normalisées ; OpenRouter et Google AI Studio via connecteurs dédiés ; clés dans vault seulement. Pour chaque fournisseur, tester authentification, coûts, streaming, outils, JSON, annulation et limites. Plusieurs comptes sont explicitement sélectionnés, sans usage qui viole les conditions fournisseur.

**Découverte :** registre de signatures (`binaryNames`, commandes `--version`, `probeTimeout`, capabilities) ; ne jamais parser des tokens secrets de dossiers d'auth ; ne pas promettre un pourcentage de quota si l'interface du fournisseur ne l'expose pas officiellement.
