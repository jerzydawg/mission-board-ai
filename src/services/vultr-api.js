const VULTR_API = 'https://api.vultr.com/v2';
const VULTR_HTTP_TIMEOUT_MS = Number(process.env.VULTR_HTTP_TIMEOUT_MS || 15000);
const VULTR_CREATE_MIN_INTERVAL_MS = Number(process.env.VULTR_CREATE_MIN_INTERVAL_MS || 11000);
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

let createQueue = Promise.resolve();
let nextCreateSlotAt = 0;

function headers() {
  if (!process.env.VULTR_API_KEY) throw new Error('VULTR_API_KEY not set');
  return {
    'Authorization': `Bearer ${process.env.VULTR_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelayMs(attempt, retryAfterHeader) {
  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  const jitterMs = Math.floor(Math.random() * 250);
  return Math.min(10000, 1000 * (2 ** attempt)) + jitterMs;
}

async function vultrFetch(path, options = {}, { label = path, retries = 4 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VULTR_HTTP_TIMEOUT_MS);

    try {
      const res = await fetch(`${VULTR_API}${path}`, {
        ...options,
        headers: {
          ...headers(),
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text();

        if (attempt < retries && RETRYABLE_STATUSES.has(res.status)) {
          const delayMs = backoffDelayMs(attempt, res.headers.get('retry-after'));
          console.warn(`[vultr-api] ${label} retry ${attempt + 1}/${retries} in ${delayMs}ms (${res.status})`);
          await sleep(delayMs);
          continue;
        }

        throw new Error(`Vultr API error: ${res.status} ${body}`);
      }

      if (res.status === 204) return null;
      return await res.json();
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (attempt < retries) {
          const delayMs = backoffDelayMs(attempt);
          console.warn(`[vultr-api] ${label} timeout retry ${attempt + 1}/${retries} in ${delayMs}ms`);
          await sleep(delayMs);
          continue;
        }

        throw new Error(`Vultr API timeout after ${VULTR_HTTP_TIMEOUT_MS}ms`);
      }

      if (attempt < retries && !error?.status) {
        const delayMs = backoffDelayMs(attempt);
        console.warn(`[vultr-api] ${label} network retry ${attempt + 1}/${retries} in ${delayMs}ms: ${error.message}`);
        await sleep(delayMs);
        continue;
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function enqueueCreate(task) {
  const queued = createQueue.then(async () => {
    const waitMs = Math.max(0, nextCreateSlotAt - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    nextCreateSlotAt = Date.now() + VULTR_CREATE_MIN_INTERVAL_MS;
    return task();
  });

  createQueue = queued.catch(() => {});
  return queued;
}

export async function listInstances() {
  const data = await vultrFetch('/instances', {}, { label: 'listInstances' });
  return data.instances;
}

export async function getInstance(id) {
  const data = await vultrFetch(`/instances/${id}`, {}, { label: `getInstance:${id}` });
  return data.instance;
}

// Pre-built snapshot with Node.js 22 + OpenClaw already installed.
// Created 2026-03-21. Reduces provisioning from 8-10 min → 2-3 min.
// Updated 2026-03-21: replaced broken snapshot (e10dec6e) with new working one.
const OPENCLAW_SNAPSHOT_ID = '7b431271-a675-4f68-bea1-03c420080eb6';

export async function createInstance({ label, region = 'ewr', plan = 'vc2-1c-2gb', userData }) {
  return enqueueCreate(async () => {
    const body = {
      region,
      plan,
      snapshot_id: OPENCLAW_SNAPSHOT_ID,
      label,
      hostname: label.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      backups: 'disabled',
      user_data: userData ? Buffer.from(userData).toString('base64') : undefined,
      tags: ['mrdelegate', 'customer'],
    };

    const data = await vultrFetch('/instances', {
      method: 'POST',
      body: JSON.stringify(body),
    }, { label: `createInstance:${label}` });

    return data.instance;
  });
}

export async function deleteInstance(id, { confirmedByFounder = false } = {}) {
  // SAFETY: Never delete an instance without explicit founder confirmation
  if (!confirmedByFounder) {
    throw new Error('SAFETY: Instance deletion requires explicit founder confirmation. Set confirmedByFounder=true only after direct Telegram approval.');
  }
  await vultrFetch(`/instances/${id}`, {
    method: 'DELETE',
  }, { label: `deleteInstance:${id}` });
  return true;
}

// Update an existing instance (e.g., rename label)
export async function updateInstance(instanceId, updates) {
  const data = await vultrFetch(`/instances/${instanceId}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  }, { label: `updateInstance(${instanceId})` });
  return data?.instance || data;
}
