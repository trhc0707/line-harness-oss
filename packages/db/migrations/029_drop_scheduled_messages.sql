-- Migration 029: Drop scheduled_messages orphan table
-- The scheduled_messages feature was never wired up: no UI, no worker endpoints,
-- no export from packages/db/src/index.ts, and processScheduledMessages was never
-- called from the cron handler. Confirmed dead code as of 2026-04-17.
-- Table was introduced in migration 013, extended in 014, and remained orphaned.
-- Prod table is empty (0 rows verified 2026-04-17).

DROP INDEX IF EXISTS idx_scheduled_messages_status_send_at;
DROP INDEX IF EXISTS idx_scheduled_messages_chat;
DROP INDEX IF EXISTS idx_scheduled_messages_friend;
DROP TABLE IF EXISTS scheduled_messages;
