-- Migration 028: Prevent duplicate non-completed friend_scenarios enrollments
-- Migration 027 attempted the same but was not applied to prod (verified 2026-04-17).
-- This is a minimal follow-up: just the partial UNIQUE index, no table recreation.
-- The application code (enrollFriendInScenario) also guards against duplicates via
-- an explicit SELECT-before-INSERT, so this index is defense-in-depth.

-- Step 1: Clean up non-completed duplicates, keeping the most progressed enrollment.
DELETE FROM friend_scenarios
WHERE status != 'completed' AND id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY friend_id, scenario_id
      ORDER BY current_step_order DESC, started_at ASC
    ) AS rn
    FROM friend_scenarios
    WHERE status != 'completed'
  ) WHERE rn = 1
);

-- Step 2: Partial UNIQUE index — only enforced on non-completed rows.
-- Re-enrollment after completion is still allowed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_scenarios_active_unique
  ON friend_scenarios (friend_id, scenario_id)
  WHERE status != 'completed';
