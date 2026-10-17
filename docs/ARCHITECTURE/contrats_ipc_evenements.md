# Spécification complémentaire : IPC et événements

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

Les interfaces ci-dessous sont **proposées**, à figer lors de T-003/T-005, et ne sont pas des API existantes.

```ts
type IPCCommand =
 | { kind: 'projects.open'; requestId: string; path: string }
 | { kind: 'agents.probe'; requestId: string }
 | { kind: 'missions.create'; requestId: string; projectId: string; teamId: string; prompt: string }
 | { kind: 'tasks.cancel'; requestId: string; taskId: string }
 | { kind: 'approvals.respond'; requestId: string; approvalId: string; decision: 'allow'|'deny' };
type IPCResult = { requestId: string; ok: true; data: unknown } | { requestId: string; ok: false; error: { code: string; message: string } };
```

- Chaque requête est validée au preload **et** côté main/core avec schéma versionné.
- Les évènements possèdent `eventId`, `aggregateId`, `aggregateVersion`, `globalSequence`, `createdAt`, `correlationId`, `causationId`, `actorType`, `actorId`, `payloadSchemaVersion`.
- Transaction DB atomique pour écriture événement + projection des statuts ; reprise idempotente et anti-duplication.
- Logs et streaming : backpressure, taille maximale par évènement, redaction et stockage contrôlé ; ne pas envoyer stdout brut avec tokens au renderer.
- Toute commande lancée via `spawn` avec tableau d'arguments, cwd contrôlé et gestion timeout/kill-tree ; aucune concaténation shell arbitraire.
- Un évènement `approval_required` doit bloquer les opérations impactantes ; toute approbation inclut portée, expiration et empreinte du plan autorisé.
