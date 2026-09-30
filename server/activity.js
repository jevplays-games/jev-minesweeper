// Discord Activity support. Discord loads the game in an iframe on <application id>.discordsays.com, where a SameSite cookie is not
// sent, so the game signs the player in through the Embedded App SDK and then keeps a bearer session token in memory.
// Nothing here changes the normal browser sign-in.
import {httpError, createSession, activityOrigin} from './security.js';
import {discordReady, discordIdentity, upsertDiscordUser} from './discord.js';
export function activityConfig(config) {
  if (!discordReady(config)) throw httpError(503, 'discord_not_configured');
  return {clientId: config.discordClientId};
}
// The origin must be this game or its own Activity proxy; the session is created for whoever Discord vouches for with the code.
export async function createActivitySession({store, config, origin, code, fetchImpl = fetch, now = Date.now()}) {
  if (!discordReady(config)) throw httpError(503, 'discord_not_configured');
  if (!origin || (origin !== activityOrigin(config) && origin !== config.origin)) throw httpError(403, 'origin_rejected');
  if (typeof code !== 'string' || !code || code.length >= 2048) throw httpError(400, 'invalid_code');
  // An SDK authorization code is exchanged without a redirect URI.
  const {user, accessToken} = await discordIdentity(config, code, null, fetchImpl);
  const player = store.transaction(() => { const p = upsertDiscordUser(store, user, now); return {...p, ...createSession(store, config, user.id, {}, now)}; });
  store.audit('activity_login_completed', {owner: `u:${user.id}`});
  // The Discord access token is returned once so the SDK can authenticate; it is never stored or logged.
  return {token: player.raw, csrfToken: player.session.csrf_token, accessToken, user: {id: player.id, displayName: player.displayName}};
}
