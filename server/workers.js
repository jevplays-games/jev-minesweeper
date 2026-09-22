import {Worker} from 'node:worker_threads';
/** Small bounded pool; failed/timed-out workers are replaced, never reused silently. */
export class Workers {
  constructor(size = 2, timeoutMs = 60000) { this.size = size; this.timeoutMs = timeoutMs; this.queue = []; this.slots = []; this.nextId = 0; this.closed = false; for (let i = 0; i < size; i++) this.spawn(i); }
  spawn(i) {
    if (this.closed) return;
    const worker = new Worker(new URL('./worker.js', import.meta.url), {execArgv: process.execArgv.filter(x => !x.startsWith('--input-type'))});
    const slot = {worker, job: null}; this.slots[i] = slot;
    worker.on('message', message => {
      const job = slot.job; if (!job || message.id !== job.id) return;
      clearTimeout(job.timer); slot.job = null;
      if (message.error) job.reject(Object.assign(new Error(message.error), {code: message.error})); else job.resolve(message.result);
      this.pump();
    });
    worker.on('error', () => this.fail(i, 'worker_error'));
    worker.on('exit', code => { if (!this.closed && this.slots[i] === slot) this.fail(i, `worker_exit_${code}`); });
  }
  fail(i, code) {
    const slot = this.slots[i]; if (!slot) return;
    this.slots[i] = null;
    if (slot.job) { clearTimeout(slot.job.timer); slot.job.reject(Object.assign(new Error(code), {code})); }
    slot.worker.removeAllListeners(); slot.worker.terminate().catch(() => {}); this.spawn(i); this.pump();
  }
  run(type, data) {
    if (this.closed || this.queue.length >= 64) return Promise.reject(new Error('worker_queue_unavailable'));
    return new Promise((resolve, reject) => { this.queue.push({id: ++this.nextId, type, data, resolve, reject}); this.pump(); });
  }
  pump() {
    this.slots.forEach((slot, i) => {
      if (!slot || slot.job || !this.queue.length) return;
      const job = this.queue.shift(); slot.job = job; job.timer = setTimeout(() => this.fail(i, 'worker_timeout'), this.timeoutMs);
      slot.worker.postMessage({id: job.id, type: job.type, data: job.data});
    });
  }
  async close() { this.closed = true; for (const job of this.queue.splice(0)) job.reject(new Error('worker_closed')); await Promise.all(this.slots.filter(Boolean).map(slot => { if (slot.job) { clearTimeout(slot.job.timer); slot.job.reject(new Error('worker_closed')); } return slot.worker.terminate(); })); }
}
