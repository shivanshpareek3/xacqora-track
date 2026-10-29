// Simple in-process job queue backed by the job table.
// A bad job backs off exponentially instead of hot-looping.
const { makeTx } = require('../db');

function enqueue(db, queueName, payload) {
  const tx = makeTx(db);
  tx.run(`INSERT INTO job (queue_name, payload, next_run_at) VALUES (?,?,?)`,
    queueName, JSON.stringify(payload), Math.floor(Date.now() / 1000));
}

async function processJob(db, id, fn) {
  const tx = makeTx(db);
  const job = tx.get(`SELECT * FROM job WHERE id=?`, id);
  if (!job) return false;
  job.attempts = job.attempts + 1;
  try {
    await fn(tx, JSON.parse(job.payload));
    tx.run(`UPDATE job SET status='done', finished_at=datetime('now') WHERE id=?`, id);
    return true;
  } catch (e) {
    const backoff = Math.min(300, 30 * Math.pow(2, job.attempts));
    const nextRun = Math.floor(Date.now() / 1000) + backoff;
    tx.run(`UPDATE job SET status='pending', attempts=?, next_run_at=?, last_error=? WHERE id=?`,
      job.attempts, nextRun, String(e.message || e).slice(0, 500), id);
    if (job.attempts >= 8) {
      tx.run(`UPDATE job SET status='dead' WHERE id=?`, id);
    }
    console.error('[job]', job.queue_name, job.id, 'retrying in', backoff, 's:', e.message);
    return false;
  }
}

// Ticks: process due jobs oldest-first. Returns number processed.
async function tick(db, adapters, maxJobs = 50) {
  const tx = makeTx(db);
  const due = tx.all(`SELECT * FROM job WHERE status='pending' AND next_run_at <= ? ORDER BY id LIMIT ?`,
    Math.floor(Date.now() / 1000), maxJobs);
  let n = 0;
  for (const job of due) {
    if (job.queue_name === 'webhook') {
      const ok = await processJob(db, job.id, (t2, payload) => adapters.handleWebhook(t2, payload));
      if (ok) n++;
    } else if (job.queue_name === 'capi') {
      const ok = await processJob(db, job.id, (t2, payload) => require('./meta').pushCapiEvent(t2, payload));
      if (ok) n++;
    } else if (job.queue_name === 'meta_pull') {
      const ok = await processJob(db, job.id, (t2, payload) => require('./meta').runMetaPull(t2, payload));
      if (ok) n++;
    }
  }
  return n;
}

module.exports = { enqueue, tick };
