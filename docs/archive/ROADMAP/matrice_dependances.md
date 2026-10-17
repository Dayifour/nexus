# Dépendances et gates de lancement

> Nexus AI — version documentaire 1.1, 10 octobre 2026. Statut : spécification, pas implémentation.

| Phase | Tickets clés | Dépendances | Critère de passage |
|---|---|---|---|
| Préparation | T-000,T-001 | environnement | preuve faisabilité CLI + stratégie confinement |
| Fondations | T-002..T-005 | ADR et contrats | démarrage application, IPC sécurisé, DB et tests |
| Orchestration | T-006..T-013 | fondations | 2 agents isolés, événements, reprise, DAG |
| Sécurité | T-014,T-015 | contrats, sandbox SPIKE | évasion/exfiltrations bloquées sur Linux |
| Intégrations/UX | T-016..T-022 | sécurité et core | Git, GitHub, Vercel, voix, quotas, UX E2E |
| Livraison | T-023..T-026 | tout le MVP | test et packaging selon OS |

Certaines phases peuvent se chevaucher si la dépendance explicite est respectée. Chaque ticket a un propriétaire de fichiers unique et une PR spécifique.
