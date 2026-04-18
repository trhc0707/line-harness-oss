/**
 * 日次サマリー — 毎朝8:00 JST にLINEプッシュで昨日のアクティビティを送信
 */

import { getLineAccounts } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';

const TAKUMA_LINE_USER_ID = 'Ua1c8e6c6612d44bc932d208720971a07';

interface DailyStats {
  newFriends: number;
  incomingMessages: number;
  formSubmissions: number;
  linkClicks: number;
  scenarioCompletions: number;
}

/**
 * Query D1 for yesterday's activity counts and send a LINE push message.
 */
export async function sendDailySummary(
  db: D1Database,
  env: { LINE_CHANNEL_ACCESS_TOKEN: string },
): Promise<void> {
  // Check if already sent today to prevent double-sends from overlapping cron windows
  const alreadySent = await hasAlreadySentToday(db);
  if (alreadySent) return;

  const stats = await queryYesterdayStats(db);
  const message = formatSummaryMessage(stats);

  // Use the first active LINE account token, falling back to env token
  const token = await resolveAccessToken(db, env.LINE_CHANNEL_ACCESS_TOKEN);
  const lineClient = new LineClient(token);

  await lineClient.pushTextMessage(TAKUMA_LINE_USER_ID, message);

  // Record that we sent today's summary (use notifications table as a log)
  await recordSummarySent(db);
}

/**
 * Get the start of "yesterday" in JST as an ISO string for DB comparison.
 * Returns [yesterdayStart, todayStart] both as JST strings.
 */
function getYesterdayRange(): { yesterdayStart: string; todayStart: string } {
  const now = new Date(Date.now() + 9 * 60 * 60_000);
  const todayStart = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0, 0, 0, 0,
  ));
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60_000);

  // Format as JST strings matching the DB format: YYYY-MM-DDTHH:mm:ss.sss+09:00
  const toJst = (d: Date) => d.toISOString().slice(0, -1) + '+09:00';
  return {
    yesterdayStart: toJst(yesterdayStart),
    todayStart: toJst(todayStart),
  };
}

async function queryYesterdayStats(db: D1Database): Promise<DailyStats> {
  const { yesterdayStart, todayStart } = getYesterdayRange();

  const [
    friendsResult,
    messagesResult,
    formsResult,
    clicksResult,
    scenariosResult,
  ] = await Promise.all([
    // New friends added yesterday
    db.prepare(
      `SELECT COUNT(*) as cnt FROM friends WHERE created_at >= ? AND created_at < ?`,
    ).bind(yesterdayStart, todayStart).first<{ cnt: number }>(),

    // Incoming messages yesterday (messages_log table, direction='incoming')
    db.prepare(
      `SELECT COUNT(*) as cnt FROM messages_log WHERE direction = 'incoming' AND created_at >= ? AND created_at < ?`,
    ).bind(yesterdayStart, todayStart).first<{ cnt: number }>(),

    // Form submissions yesterday
    db.prepare(
      `SELECT COUNT(*) as cnt FROM form_submissions WHERE created_at >= ? AND created_at < ?`,
    ).bind(yesterdayStart, todayStart).first<{ cnt: number }>(),

    // Link clicks yesterday (clicked_at column)
    db.prepare(
      `SELECT COUNT(*) as cnt FROM link_clicks WHERE clicked_at >= ? AND clicked_at < ?`,
    ).bind(yesterdayStart, todayStart).first<{ cnt: number }>(),

    // Scenario completions yesterday
    db.prepare(
      `SELECT COUNT(*) as cnt FROM friend_scenarios WHERE status = 'completed' AND updated_at >= ? AND updated_at < ?`,
    ).bind(yesterdayStart, todayStart).first<{ cnt: number }>(),
  ]);

  return {
    newFriends: friendsResult?.cnt ?? 0,
    incomingMessages: messagesResult?.cnt ?? 0,
    formSubmissions: formsResult?.cnt ?? 0,
    linkClicks: clicksResult?.cnt ?? 0,
    scenarioCompletions: scenariosResult?.cnt ?? 0,
  };
}

function formatSummaryMessage(stats: DailyStats): string {
  // Build date label like "4/8" in JST
  const now = new Date(Date.now() + 9 * 60 * 60_000);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60_000);
  const month = yesterday.getUTCMonth() + 1;
  const day = yesterday.getUTCDate();

  return [
    `\u{1F4CA} \u65E5\u6B21\u30EC\u30DD\u30FC\u30C8\uFF08${month}/${day}\uFF09`,
    '',
    `\u{1F465} \u65B0\u898F\u53CB\u3060\u3061: ${stats.newFriends}\u4EBA`,
    `\u{1F4AC} \u53D7\u4FE1\u30E1\u30C3\u30BB\u30FC\u30B8: ${stats.incomingMessages}\u4EF6`,
    `\u{1F4DD} \u30D5\u30A9\u30FC\u30E0\u56DE\u7B54: ${stats.formSubmissions}\u4EF6`,
    `\u{1F517} \u30EA\u30F3\u30AF\u30AF\u30EA\u30C3\u30AF: ${stats.linkClicks}\u4EF6`,
    `\u2705 \u30B7\u30CA\u30EA\u30AA\u5B8C\u4E86: ${stats.scenarioCompletions}\u4EF6`,
  ].join('\n');
}

/**
 * Pick the best access token: first active DB account, or fallback to env.
 */
async function resolveAccessToken(
  db: D1Database,
  envToken: string,
): Promise<string> {
  try {
    const accounts = await getLineAccounts(db);
    const active = accounts.find((a) => a.is_active);
    if (active) return active.channel_access_token;
  } catch {
    // Fall through to env token
  }
  return envToken;
}

/**
 * Check if today's summary was already sent by looking at notifications table.
 * Uses event_type = 'daily_summary' and checks created_at for today.
 */
async function hasAlreadySentToday(db: D1Database): Promise<boolean> {
  const { todayStart } = getYesterdayRange();
  const row = await db.prepare(
    `SELECT 1 FROM notifications WHERE event_type = 'daily_summary' AND created_at >= ? LIMIT 1`,
  ).bind(todayStart).first();
  return !!row;
}

/**
 * Record that today's summary was sent, using the notifications table.
 */
async function recordSummarySent(db: D1Database): Promise<void> {
  const id = crypto.randomUUID();
  const now = new Date(Date.now() + 9 * 60 * 60_000);
  const jstString = now.toISOString().slice(0, -1) + '+09:00';
  await db.prepare(
    `INSERT INTO notifications (id, event_type, title, body, channel, status, created_at)
     VALUES (?, 'daily_summary', 'Daily Summary', 'Sent daily summary to LINE', 'line', 'sent', ?)`,
  ).bind(id, jstString).run();
}
