// Discord OAuth-backed authorizers.
//
// An authorizer signs in with Discord (scopes: identify guilds.members.read).
// We store their access + refresh tokens and check, as them, whether they
// hold config.discord.role_id in config.discord.guild_id. No bot is needed
// and no server-admin rights are needed. The poller repeats the check on a
// timer (refreshing the token when it's near expiry); if the role is gone —
// or the tokens stop working because they deauthorized the app — the
// authorizer becomes invalid and everyone they vouch for loses access,
// including any live door-lock activation.

import { eq } from 'drizzle-orm';
import { db } from './db';
import { authorizers } from './schema';
import { getConfig, DiscordConfig } from './config';
import { revokeActivationsForAuthorizer } from './events';

const DISCORD_API = 'https://discord.com/api/v10';
const SCOPES = 'identify guilds.members.read';

// Refresh when less than this much lifetime remains.
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

export function discordConfig(): DiscordConfig | null {
  return getConfig().discord ?? null;
}

export function redirectUri(): string {
  const { domain } = getConfig().general;
  const proto = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(domain) ? 'http' : 'https';
  return `${proto}://${domain}/authorize/callback`;
}

export function authorizationUrl(state: string): string {
  const cfg = discordConfig();
  if (!cfg) throw new Error('Discord not configured');
  const params = new URLSearchParams({
    client_id: cfg.client_id,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    prompt: 'consent',
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const cfg = discordConfig();
  if (!cfg) throw new Error('Discord not configured');
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      ...body,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new DiscordTokenError(res.status, text.slice(0, 300));
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
  };
}

export class DiscordTokenError extends Error {
  constructor(
    public status: number,
    body: string
  ) {
    super(`token request failed: HTTP ${status} ${body}`);
  }
  // 400 invalid_grant / 401: the refresh token is dead (app deauthorized,
  // token rotated elsewhere). Not a transient failure.
  get permanent(): boolean {
    return this.status === 400 || this.status === 401;
  }
}

export function exchangeCode(code: string): Promise<TokenSet> {
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
}

export function refreshTokens(refreshToken: string): Promise<TokenSet> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

export async function fetchMe(accessToken: string): Promise<{ id: string; username: string }> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`users/@me failed: HTTP ${res.status}`);
  const json = (await res.json()) as { id: string; username: string; global_name?: string | null };
  return { id: json.id, username: json.global_name || json.username };
}

export type RoleCheck =
  | { ok: true; hasRole: boolean; isMember: boolean }
  | { ok: false; error: string; permanent: boolean };

// Does the token's owner hold the configured role in the configured guild?
// 404 = not a member (definite negative). 401 = token dead (permanent).
// Anything else is transient: callers must not revoke on it.
export async function checkRole(accessToken: string): Promise<RoleCheck> {
  const cfg = discordConfig();
  if (!cfg) return { ok: false, error: 'Discord not configured', permanent: false };

  let res: Response;
  try {
    res = await fetch(`${DISCORD_API}/users/@me/guilds/${cfg.guild_id}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    return { ok: false, error: `network error: ${(err as Error).message}`, permanent: false };
  }

  if (res.status === 404) return { ok: true, hasRole: false, isMember: false };
  if (res.status === 401) return { ok: false, error: 'access token rejected', permanent: true };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 200)}`, permanent: false };
  }

  const member = (await res.json()) as { roles?: string[] };
  return { ok: true, isMember: true, hasRole: (member.roles ?? []).includes(cfg.role_id) };
}

async function setValidity(
  row: { authorizerId: number; name: string; valid: boolean },
  valid: boolean,
  error: string | null,
  now: Date
): Promise<void> {
  await db
    .update(authorizers)
    .set({ valid, lastCheckedAt: now, lastCheckError: error })
    .where(eq(authorizers.authorizerId, row.authorizerId));
  if (row.valid && !valid) {
    console.log(
      `Authorizer ${row.authorizerId} (${row.name}) is no longer valid (${error ?? 'lost role'}); revoking dependent access`
    );
    await revokeActivationsForAuthorizer(row.authorizerId, now);
  } else if (!row.valid && valid) {
    console.log(`Authorizer ${row.authorizerId} (${row.name}) is valid again`);
  }
}

// Re-check a single authorizer and persist the result. Returns the new
// validity, or null if the check could not be completed (value unchanged).
export async function refreshAuthorizer(authorizerId: number): Promise<boolean | null> {
  const row = await db.query.authorizers.findFirst({
    where: eq(authorizers.authorizerId, authorizerId),
  });
  if (!row) return null;
  const now = new Date();

  if (row.kind !== 'discord') {
    if (!row.valid) await setValidity(row, true, null, now);
    return true;
  }

  if (!discordConfig()) {
    await db
      .update(authorizers)
      .set({ lastCheckedAt: now, lastCheckError: 'Discord is not configured' })
      .where(eq(authorizers.authorizerId, row.authorizerId));
    return null;
  }

  if (!row.discordRefreshToken || !row.discordAccessToken || !row.discordTokenExpiresAt) {
    await setValidity(row, false, 'not signed in with Discord', now);
    return false;
  }

  // Refresh the token if it's near expiry. A dead refresh token is a
  // definite loss of standing (they deauthorized us); transient failures
  // leave the old value in place.
  let accessToken = row.discordAccessToken;
  if (row.discordTokenExpiresAt.getTime() - now.getTime() < REFRESH_MARGIN_MS) {
    try {
      const t = await refreshTokens(row.discordRefreshToken);
      await db
        .update(authorizers)
        .set({
          discordAccessToken: t.accessToken,
          discordRefreshToken: t.refreshToken,
          discordTokenExpiresAt: t.expiresAt,
        })
        .where(eq(authorizers.authorizerId, row.authorizerId));
      accessToken = t.accessToken;
    } catch (err) {
      const msg = (err as Error).message;
      if (err instanceof DiscordTokenError && err.permanent) {
        await setValidity(
          row,
          false,
          `Discord sign-in expired or was revoked; sign in again (${msg})`,
          now
        );
        return false;
      }
      await db
        .update(authorizers)
        .set({ lastCheckedAt: now, lastCheckError: msg })
        .where(eq(authorizers.authorizerId, row.authorizerId));
      console.warn(`Discord token refresh failed for authorizer ${row.authorizerId}: ${msg}`);
      return null;
    }
  }

  const result = await checkRole(accessToken);
  if (!result.ok) {
    if (result.permanent) {
      await setValidity(
        row,
        false,
        `Discord sign-in expired or was revoked; sign in again (${result.error})`,
        now
      );
      return false;
    }
    await db
      .update(authorizers)
      .set({ lastCheckedAt: now, lastCheckError: result.error })
      .where(eq(authorizers.authorizerId, row.authorizerId));
    console.warn(
      `Discord check failed for authorizer ${row.authorizerId} (${row.name}): ${result.error}`
    );
    return null;
  }

  await setValidity(
    row,
    result.hasRole,
    result.hasRole
      ? null
      : result.isMember
        ? 'does not have the required role'
        : 'not a member of the server',
    now
  );
  return result.hasRole;
}

export async function refreshAllDiscordAuthorizers(): Promise<void> {
  const rows = await db.query.authorizers.findMany({ where: eq(authorizers.kind, 'discord') });
  for (const row of rows) {
    try {
      await refreshAuthorizer(row.authorizerId);
    } catch (err) {
      console.error(`Error refreshing authorizer ${row.authorizerId}:`, err);
    }
  }
}

export function startDiscordAuthorizerPoller(): void {
  const cfg = discordConfig();
  if (!cfg) {
    console.log('Discord not configured; authorizer polling disabled');
    return;
  }
  console.log(`Discord authorizer polling every ${cfg.poll_interval_minutes} min`);
  refreshAllDiscordAuthorizers().catch(err => console.error('Initial Discord poll failed:', err));
  setInterval(
    () => {
      refreshAllDiscordAuthorizers().catch(err => console.error('Discord poll failed:', err));
    },
    cfg.poll_interval_minutes * 60 * 1000
  ).unref();
}
