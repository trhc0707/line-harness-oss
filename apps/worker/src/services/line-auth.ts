/**
 * LINE ID Token verification utilities.
 *
 * Supports multi-account setups: a given LIFF / idToken may be issued by any
 * of the configured LINE Login channels. We try the default login channel
 * first, then fall back to every login channel id recorded in the
 * `line_accounts` table. Returns the decoded token on first success.
 */
import { getLineAccounts } from '@line-crm/db';
import type { Env } from '../index.js';

export interface VerifiedLineIdToken {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
  aud?: string;
}

/**
 * Verify a LINE ID token against the default login channel, then any
 * additional login channels registered via `line_accounts`.
 *
 * Throws on total failure.
 */
export async function verifyLineIdTokenAcrossAccounts(
  env: Env['Bindings'],
  idToken: string,
): Promise<VerifiedLineIdToken> {
  if (!idToken) {
    throw new Error('idToken is required');
  }

  const channelIds: string[] = [];
  if (env.LINE_LOGIN_CHANNEL_ID) channelIds.push(env.LINE_LOGIN_CHANNEL_ID);
  try {
    const dbAccounts = await getLineAccounts(env.DB);
    for (const acct of dbAccounts) {
      if (acct.login_channel_id && !channelIds.includes(acct.login_channel_id)) {
        channelIds.push(acct.login_channel_id);
      }
    }
  } catch {
    // non-fatal — fall back to env channel only
  }

  let lastErr: unknown = null;
  for (const channelId of channelIds) {
    try {
      const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
      });
      if (res.ok) {
        return (await res.json()) as VerifiedLineIdToken;
      }
      lastErr = await res.text().catch(() => 'verify failed');
    } catch (err) {
      lastErr = err;
    }
  }

  throw new Error(
    typeof lastErr === 'string'
      ? `ID token verification failed: ${lastErr}`
      : 'ID token verification failed',
  );
}
