import {readFile} from 'node:fs/promises';
import {verifyReplay, resultOf} from '../shared/replay.js';
try {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run verify -- path/to/replay.json');
  const replay = JSON.parse(await readFile(file, 'utf8'));
  const result = await verifyReplay(replay);
  console.log(JSON.stringify({valid: true, matchId: replay.matchId, events: result.events, result: resultOf(result.state)}, null, 2));
} catch (error) {
  console.error(JSON.stringify({valid: false, error: error.message})); process.exitCode = 1;
}
