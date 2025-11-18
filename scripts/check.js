const fs = require('fs').promises;
const path = require('path');
const { AbortController } = require('abort-controller');

const WORKDIR = process.cwd();
const URLS_FILE = path.join(WORKDIR, 'urls.json');
const STATUS_FILE = path.join(WORKDIR, 'statuses.json');
const CHECK_INTERVAL = process.env.CHECK_INTERVAL || '1m';
const GCHAT_WEBHOOK = process.env.GCHAT_WEBHOOK;

if (!GCHAT_WEBHOOK) {
  console.error('GCHAT_WEBHOOK is not set. Exiting.');
  process.exit(1);
}

async function loadJson(file, fallback) {
  try {
    const txt = await fs.readFile(file, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function sendChat(message) {
  try {
    await fetch(GCHAT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
  } catch (e) {
    console.error('Failed to send chat message', e);
  }
}

async function checkUrl(entry) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(entry.url, { method: 'GET', signal: controller.signal });
    clearTimeout(timeout);
    return resp.status < 400;
  } catch (e) {
    clearTimeout(timeout);
    return false;
  }
}

(async () => {
  const urls = await loadJson(URLS_FILE, []);
  let statuses = await loadJson(STATUS_FILE, {});

  // Only check entries matching this workflow's interval
  const toCheck = urls.filter(u => (u.interval || '1m') === CHECK_INTERVAL);

  if (toCheck.length === 0) {
    console.log(`No URLs to check for interval ${CHECK_INTERVAL}`);
    process.exit(0);
  }

  let changed = false;

  for (const e of toCheck) {
    const key = e.name || e.url;
    console.log(`[${nowIso()}] Checking ${key} -> ${e.url} (mode=${e.mode || 'down'})`);
    const isUp = await checkUrl(e);
    const current = isUp ? 'up' : 'down';
    const prev = statuses[e.url] || 'unknown';

    // don't notify on first unknown state to avoid noise
    if (prev === 'unknown') {
      console.log(`Prev unknown for ${e.url}, setting to ${current} (no notify)`);
      statuses[e.url] = current;
      changed = true;
      continue;
    }

    if (prev !== current) {
      // Notify only if the new state matches the mode (or mode===both)
      const mode = (e.mode || 'down').toLowerCase();
      const shouldNotify =
        mode === 'both' ||
        (mode === 'down' && current === 'down') ||
        (mode === 'up' && current === 'up');

      if (shouldNotify) {
        const msg = `${current === 'down' ? 'DOWN' : 'UP'}: ${e.name || e.url} (${e.url}) at ${nowIso()} (was ${prev})`;
        console.log('Notify:', msg);
        await sendChat(msg);
      } else {
        console.log(`State changed ${prev} -> ${current} but mode=${mode} so no notify`);
      }
      statuses[e.url] = current;
      changed = true;
    } else {
      console.log(`No change for ${e.url} (${current})`);
    }
  }

  // write statuses
  await fs.writeFile(STATUS_FILE, JSON.stringify(statuses, null, 2), 'utf8');
  if (changed) console.log('Statuses updated');
  else console.log('No status changes');
})();
