import { Hono } from 'hono';
import {
  getTrackedLinks,
  getTrackedLinkById,
  createTrackedLink,
  updateTrackedLink,
  deleteTrackedLink,
  recordLinkClick,
  getLinkClicks,
  getFriendByLineUserId,
} from '@line-crm/db';
import { addTagToFriend, enrollFriendInScenario } from '@line-crm/db';
import type { TrackedLink } from '@line-crm/db';
import type { Env } from '../index.js';
import { verifyLineIdTokenAcrossAccounts } from '../services/line-auth.js';

const trackedLinks = new Hono<Env>();

function serializeTrackedLink(row: TrackedLink, baseUrl: string) {
  const trackingUrl = `${baseUrl}/t/${row.id}`;
  return {
    id: row.id,
    name: row.name,
    originalUrl: row.original_url,
    trackingUrl,
    tagId: row.tag_id,
    scenarioId: row.scenario_id,
    introTemplateId: row.intro_template_id,
    rewardTemplateId: row.reward_template_id,
    isActive: Boolean(row.is_active),
    clickCount: row.click_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getBaseUrl(c: { req: { url: string } }): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

// GET /api/tracked-links — list all
trackedLinks.get('/api/tracked-links', async (c) => {
  try {
    const items = await getTrackedLinks(c.env.DB);
    const base = getBaseUrl(c);
    return c.json({ success: true, data: items.map((item) => serializeTrackedLink(item, base)) });
  } catch (err) {
    console.error('GET /api/tracked-links error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/tracked-links/:id — get single with click details
trackedLinks.get('/api/tracked-links/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const link = await getTrackedLinkById(c.env.DB, id);
    if (!link) {
      return c.json({ success: false, error: 'Tracked link not found' }, 404);
    }
    const clicks = await getLinkClicks(c.env.DB, id);
    const base = getBaseUrl(c);
    return c.json({
      success: true,
      data: {
        ...serializeTrackedLink(link, base),
        clicks: clicks.map((click) => ({
          id: click.id,
          friendId: click.friend_id,
          friendDisplayName: click.friend_display_name,
          clickedAt: click.clicked_at,
        })),
      },
    });
  } catch (err) {
    console.error('GET /api/tracked-links/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/tracked-links — create
trackedLinks.post('/api/tracked-links', async (c) => {
  try {
    const body = await c.req.json<{
      name: string;
      originalUrl: string;
      tagId?: string | null;
      scenarioId?: string | null;
      introTemplateId?: string | null;
      rewardTemplateId?: string | null;
    }>();

    if (!body.name || !body.originalUrl) {
      return c.json({ success: false, error: 'name and originalUrl are required' }, 400);
    }

    const link = await createTrackedLink(c.env.DB, {
      name: body.name,
      originalUrl: body.originalUrl,
      tagId: body.tagId ?? null,
      scenarioId: body.scenarioId ?? null,
      introTemplateId: body.introTemplateId ?? null,
      rewardTemplateId: body.rewardTemplateId ?? null,
    });

    const base = getBaseUrl(c);
    return c.json({ success: true, data: serializeTrackedLink(link, base) }, 201);
  } catch (err) {
    console.error('POST /api/tracked-links error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PATCH /api/tracked-links/:id — update mutable fields
trackedLinks.patch('/api/tracked-links/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      name?: string;
      tagId?: string | null;
      scenarioId?: string | null;
      introTemplateId?: string | null;
      rewardTemplateId?: string | null;
      isActive?: boolean;
    }>();

    const link = await updateTrackedLink(c.env.DB, id, body);
    if (!link) {
      return c.json({ success: false, error: 'Tracked link not found' }, 404);
    }
    const base = getBaseUrl(c);
    return c.json({ success: true, data: serializeTrackedLink(link, base) });
  } catch (err) {
    console.error('PATCH /api/tracked-links/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/tracked-links/:id
trackedLinks.delete('/api/tracked-links/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const link = await getTrackedLinkById(c.env.DB, id);
    if (!link) {
      return c.json({ success: false, error: 'Tracked link not found' }, 404);
    }
    await deleteTrackedLink(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/tracked-links/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// Domains where Universal Links should be used (JS redirect instead of 302)
const APP_LINK_DOMAINS = new Set([
  'x.com',
  'twitter.com',
  'instagram.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'facebook.com',
  'github.com',
]);

function isAppLinkDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return APP_LINK_DOMAINS.has(hostname);
  } catch {
    return false;
  }
}

// Android app package names for intent:// deep links
const ANDROID_PACKAGES: Record<string, string> = {
  'x.com': 'com.twitter.android',
  'twitter.com': 'com.twitter.android',
  'instagram.com': 'com.instagram.android',
  'youtube.com': 'com.google.android.youtube',
  'youtu.be': 'com.google.android.youtube',
  'tiktok.com': 'com.zhiliaoapp.musically',
  'facebook.com': 'com.facebook.katana',
  'github.com': 'com.github.android',
};

function getAndroidPackage(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return ANDROID_PACKAGES[hostname] ?? null;
  } catch {
    return null;
  }
}

function buildAppRedirectHtml(destinationUrl: string): string {
  const escaped = destinationUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const androidPackage = getAndroidPackage(destinationUrl);
  // intent://path#Intent;scheme=https;package=com.xxx;S.browser_fallback_url=https://...;end
  const intentUrl = androidPackage
    ? `intent://${destinationUrl.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=${androidPackage};S.browser_fallback_url=${encodeURIComponent(destinationUrl)};end`
    : null;
  const intentEscaped = intentUrl ? intentUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;') : '';

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Redirecting...</title>
<style>body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui;color:#64748b;background:#f8fafc}p{font-size:14px}</style>
</head><body>
<p>Opening app...</p>
<script>
(function(){
  var isAndroid = /Android/i.test(navigator.userAgent);
  if(isAndroid && "${intentEscaped}"){
    window.location.href="${intentEscaped}";
  } else {
    window.location.href="${escaped}";
  }
})();
</script>
<noscript><meta http-equiv="refresh" content="0;url=${escaped}"></noscript>
</body></html>`;
}

// ──────────────────────────────────────────────────────────────
// Internal LIFF form detection + bridge HTML
// ──────────────────────────────────────────────────────────────

/**
 * Detect whether the original_url points at our own LIFF form page
 * (liff.line.me/<LIFF_ID>?page=form&id=<FORM_ID>). Such URLs must NOT
 * be served as 302 redirects outside of the LINE app: the liff.line.me
 * page forces LINE Login in an external browser, which defeats the
 * "no login screen" requirement. Instead we render a bridge HTML with
 * an explicit "LINEで開く" button (mobile) or QR code (desktop).
 */
function detectInternalFormEntry(
  originalUrl: string,
  envLiffUrl: string | undefined,
): { formId: string; liffId: string; entryUrl: string } | null {
  let original: URL;
  try {
    original = new URL(originalUrl);
  } catch {
    return null;
  }
  if (original.hostname !== 'liff.line.me') return null;
  if (original.searchParams.get('page') !== 'form') return null;
  const formId = original.searchParams.get('id');
  if (!formId) return null;

  // Prefer LIFF id that's already embedded in original_url path
  // (e.g. liff.line.me/2009694483-DtQIOZl4). Fall back to env LIFF_URL.
  const pathMatch = original.pathname.match(/\/([0-9]+-[A-Za-z0-9]+)/);
  let liffId = pathMatch ? pathMatch[1] : '';
  if (!liffId && envLiffUrl) {
    const envMatch = envLiffUrl.match(/liff\.line\.me\/([0-9]+-[A-Za-z0-9]+)/);
    if (envMatch) liffId = envMatch[1];
  }
  if (!liffId) return null;

  return { formId, liffId, entryUrl: '' };
}

function buildFormEntryUrl(liffId: string, formId: string, linkId: string): string {
  const params = new URLSearchParams();
  params.set('entry', 'form');
  params.set('id', formId);
  params.set('ref', linkId);
  return `https://liff.line.me/${liffId}?${params.toString()}`;
}

function renderLineBridgePage(entryUrl: string): string {
  const escaped = entryUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LINEでフォームを開きます</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Helvetica Neue',system-ui,sans-serif;background:#f5f7f5;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:16px;color:#222}
.card{background:#fff;border-radius:20px;box-shadow:0 2px 20px rgba(0,0,0,0.06);text-align:center;max-width:380px;width:100%;padding:44px 28px 36px;border:1px solid rgba(0,0,0,0.04)}
.line-icon{width:56px;height:56px;margin:0 auto 20px}
.line-icon svg{width:56px;height:56px}
.title{font-size:19px;font-weight:700;margin-bottom:10px;line-height:1.5}
.sub{font-size:13px;color:#666;margin-bottom:28px;line-height:1.7}
.btn{display:block;width:100%;padding:18px;border:none;border-radius:14px;font-size:17px;font-weight:700;text-decoration:none;text-align:center;color:#fff;background:#06C755;box-shadow:0 4px 14px rgba(6,199,85,0.25);transition:all .15s}
.btn:active{transform:scale(0.98);opacity:.9}
.footer{font-size:11px;color:#bbb;margin-top:20px;line-height:1.5}
</style>
</head>
<body>
<div class="card">
<div class="line-icon">
<svg viewBox="0 0 48 48" fill="none"><rect width="48" height="48" rx="12" fill="#06C755"/><path d="M24 12C17.37 12 12 16.58 12 22.2c0 3.54 2.35 6.65 5.86 8.47-.2.74-.76 2.75-.87 3.17-.14.55.2.54.42.39.18-.12 2.84-1.88 4-2.65.84.13 1.7.22 2.59.22 6.63 0 12-4.58 12-10.2S30.63 12 24 12z" fill="#fff"/></svg>
</div>
<p class="title">LINEでフォームを開きます</p>
<p class="sub">ボタンを押すとLINEアプリで<br>フォームが開きます</p>
<a href="${escaped}" class="btn">LINEで開く</a>
<p class="footer">既に友だちの方はそのままフォームに進みます</p>
</div>
</body>
</html>`;
}

function renderQrPage(entryUrl: string): string {
  const escaped = entryUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LINE で開く</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Helvetica Neue',system-ui,sans-serif;background:#f5f7f5;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#fff;border-radius:20px;box-shadow:0 2px 20px rgba(0,0,0,0.06);text-align:center;max-width:480px;width:90%;padding:48px;border:1px solid rgba(0,0,0,0.04)}
.line-icon{width:48px;height:48px;margin:0 auto 20px}
.line-icon svg{width:48px;height:48px}
.title{font-size:17px;color:#222;font-weight:700;margin-bottom:8px;line-height:1.5}
.msg{font-size:14px;color:#666;margin-bottom:28px;line-height:1.6}
.qr{background:#f9f9f9;border-radius:16px;padding:24px;display:inline-block;margin-bottom:20px;border:1px solid rgba(0,0,0,0.04)}
.qr img{display:block;width:240px;height:240px}
.hint{font-size:13px;color:#999;line-height:1.6;margin-bottom:16px}
.alt{font-size:12px;color:#999;line-height:1.6}
.alt a{color:#06C755;word-break:break-all}
.footer{font-size:11px;color:#bbb;margin-top:24px;line-height:1.5}
</style>
</head>
<body>
<div class="card">
<div class="line-icon">
<svg viewBox="0 0 48 48" fill="none"><rect width="48" height="48" rx="12" fill="#06C755"/><path d="M24 12C17.37 12 12 16.58 12 22.2c0 3.54 2.35 6.65 5.86 8.47-.2.74-.76 2.75-.87 3.17-.14.55.2.54.42.39.18-.12 2.84-1.88 4-2.65.84.13 1.7.22 2.59.22 6.63 0 12-4.58 12-10.2S30.63 12 24 12z" fill="#fff"/></svg>
</div>
<p class="title">スマホのLINEアプリで<br>読み取ってください</p>
<p class="msg">友だち追加〜フォーム送信まで<br>LINEアプリ内で完結します</p>
<div class="qr">
<img src="/api/qr?size=240x240&data=${encodeURIComponent(entryUrl)}" alt="QR Code">
</div>
<p class="hint">LINEアプリのカメラまたは<br>スマートフォンのカメラで読み取れます</p>
<p class="alt">PCのブラウザで続ける場合は<br><a href="${escaped}">こちらから開く</a></p>
<p class="footer">友だち追加で全機能を無料体験できます</p>
</div>
</body>
</html>`;
}

/**
 * Shared helper: run tag + scenario actions for a newly-identified friend
 * after a tracked link click. Mirrors the async block in /t/:linkId so both
 * the GET redirect and POST /resolve endpoints can enroll the friend
 * identically (including immediate first-step delivery).
 */
async function applyLinkActions(
  env: Env['Bindings'],
  linkId: string,
  link: TrackedLink,
  friendId: string,
): Promise<void> {
  const actions: Promise<unknown>[] = [];
  if (link.tag_id) actions.push(addTagToFriend(env.DB, friendId, link.tag_id));
  if (link.scenario_id) actions.push(enrollFriendInScenario(env.DB, friendId, link.scenario_id));
  if (actions.length > 0) await Promise.allSettled(actions);

  // Immediate delivery of first scenario step (skip waiting for cron)
  if (!link.scenario_id) return;
  try {
    const {
      getScenarioSteps,
      getFriendById,
      jstNow,
      claimFriendScenarioForDelivery,
      advanceFriendScenario,
      completeFriendScenario,
      getLineAccountById,
    } = await import('@line-crm/db');
    const friend = await getFriendById(env.DB, friendId);
    if (!friend?.line_user_id || !(friend as any).is_following) return;
    const fsRow = await env.DB
      .prepare(
        `SELECT id, current_step_order FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ? LIMIT 1`,
      )
      .bind(friendId, link.scenario_id)
      .first<{ id: string; current_step_order: number }>();
    if (!fsRow) return;
    const steps = await getScenarioSteps(env.DB, link.scenario_id);
    const currentStep = steps.find((s: any) => s.step_order > fsRow.current_step_order);
    if (!currentStep || currentStep.delay_minutes !== 0) return;
    const claimed = await claimFriendScenarioForDelivery(env.DB, fsRow.id, fsRow.current_step_order);
    if (!claimed) return;
    const { buildMessage, expandVariables, resolveMetadata } = await import(
      '../services/step-delivery.js'
    );
    const { LineClient } = await import('@line-crm/line-sdk');
    const resolvedMeta = await resolveMetadata(env.DB, {
      user_id: (friend as any).user_id,
      metadata: (friend as any).metadata,
    });
    const expanded = expandVariables(
      currentStep.message_content,
      { ...friend, metadata: resolvedMeta } as any,
      env.WORKER_URL,
    );
    let accessToken = env.LINE_CHANNEL_ACCESS_TOKEN;
    const accountId = (friend as any).line_account_id;
    if (accountId) {
      const acct = await getLineAccountById(env.DB, accountId);
      if (acct) accessToken = acct.channel_access_token;
    }
    const client = new LineClient(accessToken);
    const message = buildMessage(currentStep.message_type, expanded);
    await client.pushMessage(friend.line_user_id, [message]);
    const logId = crypto.randomUUID();
    await env.DB
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at) VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, 'push', ?)`,
      )
      .bind(
        logId,
        friendId,
        currentStep.message_type,
        currentStep.message_content,
        currentStep.id,
        jstNow(),
      )
      .run();
    const nextIndex = steps.indexOf(currentStep) + 1;
    if (nextIndex < steps.length) {
      const nextStep = steps[nextIndex];
      const nextDate = new Date(
        Date.now() + 9 * 60 * 60_000 + (nextStep.delay_minutes || 0) * 60_000,
      );
      await advanceFriendScenario(
        env.DB,
        fsRow.id,
        currentStep.step_order,
        nextDate.toISOString().slice(0, -1) + '+09:00',
      );
    } else {
      await completeFriendScenario(env.DB, fsRow.id);
    }
  } catch (err) {
    console.error(`applyLinkActions(${linkId}) immediate delivery error:`, err);
  }
}

// ──────────────────────────────────────────────────────────────
// POST /api/tracked-links/:linkId/resolve
// Called by the LIFF client once it knows the LINE user id. Records the
// click, applies tag/scenario enrollment, and triggers immediate first-step
// delivery — identical to the /t/:linkId side-effects but for the
// in-LIFF entry flow where the user never actually hits /t/.
// ──────────────────────────────────────────────────────────────
trackedLinks.post('/api/tracked-links/:linkId/resolve', async (c) => {
  try {
    const linkId = c.req.param('linkId');
    const body = await c.req.json<{ lineUserId: string; idToken: string }>();
    if (!body?.lineUserId || !body?.idToken) {
      return c.json({ success: false, error: 'lineUserId and idToken are required' }, 400);
    }

    let verified: { sub: string };
    try {
      verified = await verifyLineIdTokenAcrossAccounts(c.env, body.idToken);
    } catch {
      return c.json({ success: false, error: 'Invalid idToken' }, 401);
    }
    if (verified.sub !== body.lineUserId) {
      return c.json({ success: false, error: 'Token mismatch' }, 403);
    }

    const link = await getTrackedLinkById(c.env.DB, linkId);
    if (!link || !link.is_active) {
      return c.json({ success: false, error: 'Link not found' }, 404);
    }

    const friend = await getFriendByLineUserId(c.env.DB, body.lineUserId);
    // Record click regardless; friendId may be null (brand-new, webhook not fired yet)
    await recordLinkClick(c.env.DB, linkId, friend?.id ?? null);
    if (!friend) {
      return c.json({ success: true, data: { friendId: null, pending: true } });
    }

    const ctx = c.executionCtx as ExecutionContext;
    ctx.waitUntil(applyLinkActions(c.env, linkId, link, friend.id));

    return c.json({ success: true, data: { friendId: friend.id } });
  } catch (err) {
    console.error('POST /api/tracked-links/:linkId/resolve error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /t/:linkId — click tracking redirect (no auth, fast redirect)
trackedLinks.get('/t/:linkId', async (c) => {
  const linkId = c.req.param('linkId');
  const lineUserId = c.req.query('lu') ?? null;
  let friendId = c.req.query('f') ?? null;

  // Look up the link first
  const link = await getTrackedLinkById(c.env.DB, linkId);

  if (!link || !link.is_active) {
    return c.json({ success: false, error: 'Link not found' }, 404);
  }

  const ua = c.req.header('user-agent') || '';
  const isLineApp = /\bLine\//i.test(ua);
  const isMobile = /iphone|ipad|android|mobile/i.test(ua.toLowerCase());
  const ctx = c.executionCtx as ExecutionContext;

  // ── Internal LIFF form entry: never 302 to liff.line.me outside LINE ──
  // note記事 CTA など外部ブラウザから来た場合、302 で liff.line.me に飛ばすと
  // LINE Login のWebログイン画面が挟まる。ここで分岐し、
  //   ・LINEアプリ内  → 302 で LIFF entry URL に飛ばす（アプリがそのまま開く）
  //   ・モバイルブラウザ → bridge HTML で「LINEで開く」ボタン提示
  //   ・デスクトップ → QRコード
  const internal = detectInternalFormEntry(link.original_url, c.env.LIFF_URL);
  if (internal) {
    const entryUrl = buildFormEntryUrl(internal.liffId, internal.formId, linkId);

    // Resolve friendId if we already know the lineUserId (typically null here
    // because LIFF hasn't loaded yet, but preserve behavior for /t?lu=...).
    if (!friendId && lineUserId) {
      const friend = await getFriendByLineUserId(c.env.DB, lineUserId);
      if (friend) friendId = friend.id;
    }

    ctx.waitUntil(
      (async () => {
        try {
          await recordLinkClick(c.env.DB, linkId, friendId);
          if (friendId) {
            await applyLinkActions(c.env, linkId, link, friendId);
          }
        } catch (err) {
          console.error(`/t/${linkId} (internal) async tracking error:`, err);
        }
      })(),
    );

    if (isLineApp) return c.redirect(entryUrl, 302);
    if (isMobile) return c.html(renderLineBridgePage(entryUrl));
    return c.html(renderQrPage(entryUrl));
  }

  const useAppRedirect = isAppLinkDomain(link.original_url);

  // If no user ID yet, check if this is LINE's in-app browser → redirect to LIFF for identification
  // Skip LIFF redirect for app-link domains (they'll come from Safari via externalBrowser)
  if (!useAppRedirect && !lineUserId && !friendId && isLineApp && c.env.LIFF_URL) {
    const directUrl = `${c.env.WORKER_URL || new URL(c.req.url).origin}/t/${linkId}`;
    const liffRedirect = `${c.env.LIFF_URL}?redirect=${encodeURIComponent(directUrl)}`;
    return c.redirect(liffRedirect, 302);
  }

  // Resolve friendId from LINE user ID if provided
  if (!friendId && lineUserId) {
    const friend = await getFriendByLineUserId(c.env.DB, lineUserId);
    if (friend) {
      friendId = friend.id;
    }
  }

  // Run side-effects async (click recording, tag/scenario actions)
  ctx.waitUntil(
    (async () => {
      try {
        await recordLinkClick(c.env.DB, linkId, friendId);
        if (friendId) {
          await applyLinkActions(c.env, linkId, link, friendId);
        }
      } catch (err) {
        console.error(`/t/${linkId} async tracking error:`, err);
      }
    })(),
  );

  // App-link domains: return HTML with JS redirect for Universal Link support
  if (useAppRedirect) {
    return c.html(buildAppRedirectHtml(link.original_url));
  }

  return c.redirect(link.original_url, 302);
});

export { trackedLinks };
