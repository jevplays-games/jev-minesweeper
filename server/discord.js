import {token, hash, equal, httpError, saveSession, createSession, writeCookie, verifyDiscordSignature} from './security.js';
const validId = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
export function discordReady(config) { return Boolean(config.discordClientId && config.discordClientSecret); }
export function loginUrl(store, config, session, now = Date.now()) {
  if (!discordReady(config)) throw httpError(503, 'discord_not_configured');
  const state = token(); session.data.oauth = {stateHash: hash(state), expiresAt: now + 600000}; saveSession(store, session);
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({client_id: config.discordClientId, response_type: 'code', redirect_uri: `${config.origin}/api/auth/discord/callback`, scope: 'identify', state}).toString(); return url.toString();
}
export async function oauthCallback({store, config, session, params, res, fetchImpl = fetch, now = Date.now()}) {
  if (!session || !session.data.oauth || session.data.oauth.expiresAt < now || !equal(session.data.oauth.stateHash, hash(params.get('state') || ''))) throw httpError(403, 'oauth_state_rejected');
  delete session.data.oauth; saveSession(store, session);
  const code = params.get('code'); if (!code || code.length > 4096 || params.has('error')) throw httpError(400, 'oauth_authorization_denied');
  const reply = await fetchImpl('https://discord.com/api/v10/oauth2/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({client_id: config.discordClientId, client_secret: config.discordClientSecret, grant_type: 'authorization_code', code, redirect_uri: `${config.origin}/api/auth/discord/callback`}), signal: AbortSignal.timeout(10000)});
  if (!reply.ok) throw httpError(502, 'oauth_token_exchange_failed');
  const access = await reply.json(); if (typeof access.access_token !== 'string') throw httpError(502, 'oauth_invalid_token_response');
  const identity = await fetchImpl('https://discord.com/api/v10/users/@me', {headers: {'Authorization': `Bearer ${access.access_token}`}, signal: AbortSignal.timeout(10000)});
  if (!identity.ok) throw httpError(502, 'discord_identity_failed');
  const user = await identity.json(); if (!validId(user.id)) throw httpError(502, 'discord_identity_invalid');
  const displayName = String(user.global_name || user.username || 'Discord player').slice(0, 80);
  const avatar = typeof user.avatar === 'string' && /^(a_)?[a-f0-9]{32}$/.test(user.avatar) ? user.avatar : null;
  const fresh = store.transaction(() => {
    store.run('INSERT INTO users(discord_id,display_name,avatar_hash,created_at,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(discord_id) DO UPDATE SET display_name=excluded.display_name,avatar_hash=excluded.avatar_hash,last_seen_at=excluded.last_seen_at', user.id, displayName, avatar, now, now);
    store.run('DELETE FROM sessions WHERE token_hash=?', session.token_hash);
    return createSession(store, config, user.id, {}, now);
  });
  writeCookie(res, config, fresh.raw); store.audit('login_completed', {owner: `u:${user.id}`});
  // Access/refresh tokens are not written to disk or returned to the browser.
  return fresh.session;
}
export function interaction({raw, headers, store, config, now = Date.now()}) {
  if (!verifyDiscordSignature(raw, headers, config.discordPublicKey, now)) throw httpError(401, 'discord_signature_invalid');
  let data; try { data = JSON.parse(raw.toString('utf8')); } catch { throw httpError(400, 'invalid_json'); }
  if (data.type === 1) return {type: 1};
  if (data.type !== 2 || data.application_id !== config.discordClientId || data.data?.name !== 'jev') throw httpError(400, 'unsupported_interaction');
  const uid = data.member?.user?.id;
  if (!validId(data.id) || !validId(uid) || !validId(data.guild_id) || !validId(data.channel_id) || data.channel?.type !== 0 || (data.context !== undefined && data.context !== 0)) return {type: 4, data: {flags: 64, content: 'Use /jev in a server text channel. Direct messages and threads are not supported.'}};
  const subcommand = data.data.options?.[0];
  if (subcommand?.name !== 'play') return {type: 4, data: {flags: 64, content: 'Use /jev play to launch Minesweeper.'}};
  const rawTicket = token(), expires = now + config.launchLifetimeMs;
  try { store.run('INSERT INTO launch_tickets(token_hash,interaction_id,discord_user_id,guild_id,channel_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?)', hash(rawTicket), data.id, uid, data.guild_id, data.channel_id, now, expires); }
  catch (e) { if (String(e.message).includes('UNIQUE')) return {type: 4, data: {flags: 64, content: 'This launch was already issued. Run /jev play again for a new link.'}}; throw e; }
  // Fragment keeps the ticket out of HTTP request paths and access logs.
  return {type: 4, data: {flags: 64, content: 'Your private launch expires in 10 minutes. Sign in with the Discord account that invoked this command.', components: [{type: 1, components: [{type: 2, style: 5, label: 'Play Minesweeper vs JEV', url: `${config.origin}/#launch=${rawTicket}`}]}]}};
}
export function resolveContext(store, session, body, config, now = Date.now()) {
  if (body.launchTicket) {
    if (!session.user_id) throw httpError(401, 'discord_login_required_for_launch');
    if (!/^[A-Za-z0-9_-]{43}$/.test(body.launchTicket)) throw httpError(403, 'invalid_launch_ticket');
    const ticketHash = hash(body.launchTicket), t = store.get('SELECT * FROM launch_tickets WHERE token_hash=?', ticketHash);
    if (!t || t.discord_user_id !== session.user_id || t.expires_at <= now || t.consumed_at) throw httpError(403, 'launch_ticket_rejected');
    return {guildId: t.guild_id, channelId: t.channel_id, expiresAt: now + config.contextLifetimeMs, invokedAt: t.created_at, ticketHash};
  }
  if (body.context === 'current') {
    const context = session.data.context;
    if (!context || context.expiresAt <= now || !session.user_id) throw httpError(403, 'community_launch_required');
    return {...context, ticketHash: null};
  }
  return null;
}
export function authorizeScope(session, scope, now = Date.now()) {
  if (scope === 'world') return null;
  if (!['server', 'channel'].includes(scope)) throw httpError(422, 'invalid_scope');
  const context = session?.data.context;
  if (!session?.user_id || !context || context.expiresAt <= now) throw httpError(403, 'community_launch_required');
  return context;
}
