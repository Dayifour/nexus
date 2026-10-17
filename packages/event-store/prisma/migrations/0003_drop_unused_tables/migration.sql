-- Tables jamais alimentées (ou dont la projection a été retirée avec l'ancien bus de messages inter-agents).
-- Le journal `events` reste intact : les anciens événements `message.sent` / `artifact.published` y sont conservés
-- et simplement ignorés au rejeu. Les index de ces tables disparaissent avec elles.
DROP TABLE IF EXISTS "messages";
DROP TABLE IF EXISTS "artifacts";
DROP TABLE IF EXISTS "worktrees";
DROP TABLE IF EXISTS "decisions";
DROP TABLE IF EXISTS "memory_entries";
DROP TABLE IF EXISTS "deployment_runs";
DROP TABLE IF EXISTS "voice_transcripts";
DROP TABLE IF EXISTS "permission_policies";
DROP TABLE IF EXISTS "provider_accounts";
