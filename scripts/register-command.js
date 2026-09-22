/** Operator-run registration only. No bot token or persistent credential token is needed. */
const api = 'https://discord.com/api/v10';
async function json(response, label) {
  if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status}); check the application credentials and Discord permissions.`);
  return response.json();
}
try {
  const id = process.env.DISCORD_CLIENT_ID, secret = process.env.DISCORD_CLIENT_SECRET;
  if (!/^\d{5,25}$/.test(id || '') || !secret) throw new Error('Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in .env.');
  const guild = process.env.DISCORD_TEST_GUILD_ID;
  if (guild && !/^\d{5,25}$/.test(guild)) throw new Error('Invalid DISCORD_TEST_GUILD_ID');
  const token = await json(await fetch(`${api}/oauth2/token`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: {Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({grant_type: 'client_credentials', scope: 'applications.commands.update'})
  }), 'Token exchange');
  const command = {name: 'jev', description: 'Play against JEV', type: 1,
    options: [{type: 1, name: 'play', description: 'Race JEV on independent Minesweeper boards'}]};
  if (!guild) { command.integration_types = [0]; command.contexts = [0]; }
  const path = guild ? `/applications/${id}/guilds/${guild}/commands` : `/applications/${id}/commands`;
  const result = await json(await fetch(api + path, {method: 'POST', signal: AbortSignal.timeout(15000),
    headers: {Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(command)}), 'Command registration');
  // POST upserts only /jev; it does not bulk-delete unrelated commands.
  console.log(JSON.stringify({registered: result.name, commandId: result.id, scope: guild ? 'test-guild' : 'global'}, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
