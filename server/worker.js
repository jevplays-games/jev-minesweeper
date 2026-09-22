import {parentPort} from 'node:worker_threads';
import {decisionSurface} from '../shared/solver.js';
import {verifyReplay} from '../shared/replay.js';
import {analyzeReplay} from '../shared/analytics.js';
parentPort.on('message', async ({id, type, data}) => {
  try {
    let result;
    if (type === 'surface') result = decisionSurface(data.observation, data.difficulty);
    else if (type === 'verify') { const checked = await verifyReplay(data.replay); result = {verified: checked.verified, events: checked.events}; }
    else if (type === 'analytics') result = await analyzeReplay(data.replay, data.options);
    else throw new Error('unknown_worker_operation');
    parentPort.postMessage({id, result});
  } catch (e) { parentPort.postMessage({id, error: e.code || e.message || 'worker_failure'}); }
});
