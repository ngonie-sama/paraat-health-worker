/**
 * Paraat endpoint health worker
 * -----------------------------------------------------------------------------
 * On a cron schedule it:
 *   1. Fetches the live probe list from the Paraat backend
 *      (GET {PARAAT_API_BASE}/api/health/agents, secured by X-Health-Token).
 *   2. Authenticated-pings each LLM provider THROUGH the Cloudflare AI Gateway
 *      (cf-aig-authorization) using cheap model-list endpoints — no token spend.
 *   3. Pings each RAG / custom agent endpoint directly.
 *   4. Alerts (Slack/Discord/webhook) when something goes down or recovers.
 *
 * GET the worker URL to run an on-demand check and see JSON status.
 * Add ?alert=1 to also fire alerts on demand.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 1_500;

export default {
  async scheduled(event, env, ctx) {
    // Two cron triggers: the frequent one runs cheap pings only; the daily one
    // (SYNTHETIC_CRON) additionally runs the real, token-spending synthetic test.
    const synthetic = String(env.RUN_SYNTHETIC) !== 'false' && event.cron === (env.SYNTHETIC_CRON || '0 6 * * *');
    ctx.waitUntil(runChecks(env, { alert: true, synthetic }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // Optional read protection for the status endpoint.
    if (env.STATUS_TOKEN) {
      const token = request.headers.get('x-status-token') || url.searchParams.get('token');
      if (token !== env.STATUS_TOKEN) {
        return json({ success: false, error: 'unauthorized' }, 401);
      }
    }

    // On-demand: add ?synthetic=1 to also run the real prompt test.
    const result = await runChecks(env, {
      alert: url.searchParams.get('alert') === '1',
      synthetic: url.searchParams.get('synthetic') === '1',
    });
    const anyDown = result.summary.down > 0 || result.summary.degraded > 0;
    return json(result, anyDown ? 503 : 200);
  },
};

// ── Core ─────────────────────────────────────────────────────────────────────

async function runChecks(env, { alert, synthetic = false }) {
  const startedAt = new Date().toISOString();

  let manifest;
  try {
    manifest = await loadTargets(env);
  } catch (err) {
    const result = {
      success: false,
      started_at: startedAt,
      error: `Failed to load targets: ${err.message}`,
      summary: { total: 0, up: 0, degraded: 0, down: 1 },
      results: [],
    };
    // A dead health-source is itself an outage worth alerting on.
    if (alert) await sendAlert(env, formatSourceFailure(env, err));
    await saveLastRun(env, result);
    return result;
  }

  const gateway = manifest.gateway || {};
  const probes = [
    ...(manifest.providers || []).map((p) => providerProbe(gateway, p, env)),
    ...(manifest.rag_endpoints || []).map((r) => directProbe(r, env)),
    ...(manifest.mcp_endpoints || []).map((r) => directProbe(r, env)),
  ];

  const pingResults = (await Promise.all(probes.map((p) => runProbe(p)))).map((r) => ({ ...r, test: 'ping' }));

  // Real end-to-end user test — the thing a ping can't prove. Runs only on the
  // daily cron (or on-demand via ?synthetic=1).
  const syntheticResults = synthetic ? await runSynthetic(env) : [];

  const results = [...pingResults, ...syntheticResults];

  const summary = results.reduce(
    (acc, r) => {
      acc.total += 1;
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    },
    { total: 0, up: 0, degraded: 0, down: 0 }
  );

  const result = {
    success: true,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    source: `${trimSlash(env.PARAAT_API_BASE)}/api/health/agents`,
    summary,
    results,
  };

  if (alert) await handleAlerts(env, results);
  await saveLastRun(env, result);
  return result;
}

// ── Real end-to-end synthetic test ───────────────────────────────────────────

/**
 * Triggers the backend synthetic endpoint, which sends real prompts through the
 * live chat pipeline and waits for real answers. Invoked only on the daily cron
 * (or on-demand), so no counter/KV throttle is needed. Returns worker-shaped rows.
 */
async function runSynthetic(env) {
  const url = `${trimSlash(env.PARAAT_API_BASE)}/api/health/synthetic`;
  const timeoutMs = Math.max(20_000, parseInt(env.SYNTHETIC_TIMEOUT_MS || '150000', 10));

  try {
    const res = await withTimeout(
      (signal) =>
        fetch(url, {
          method: 'POST',
          headers: { 'X-Health-Token': env.PARAAT_HEALTH_TOKEN || '', Accept: 'application/json' },
          signal,
        }),
      timeoutMs
    );

    // The endpoint returns 503 (with a JSON body) when a target failed — that's a
    // valid result, not a transport error. Parse the body regardless of status.
    const data = await res.json().catch(() => null);
    if (!data) {
      return [syntheticEndpointDown(`non-JSON response (HTTP ${res.status})`)];
    }

    // Config-level problems (disabled / misconfigured / no user) → single row.
    if (!Array.isArray(data.results) || data.results.length === 0) {
      const status = data.status === 'up' ? 'up' : data.status === 'disabled' ? 'up' : 'down';
      return [
        {
          id: 'synthetic:runner',
          name: 'Synthetic runner',
          provider: 'synthetic',
          kind: 'synthetic',
          via: 'synthetic',
          test: 'synthetic',
          status,
          http_status: res.status,
          latency_ms: null,
          note: data.message || data.status || 'no targets',
        },
      ];
    }

    return data.results.map((r) => ({
      id: `synthetic:${r.id || r.provider}`,
      name: r.name || r.provider,
      provider: r.provider,
      kind: `synthetic:${r.kind || 'llm'}`,
      via: 'synthetic',
      test: 'synthetic',
      status: r.status === 'up' || r.status === 'degraded' ? r.status : 'down',
      http_status: null,
      latency_ms: r.latency_ms ?? null,
      note: r.error || (r.response ? `answered: ${String(r.response).slice(0, 80)}` : 'real prompt ok'),
    }));
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    return [syntheticEndpointDown(timedOut ? `timeout after ${timeoutMs}ms` : `network error: ${err.message}`)];
  }
}

function syntheticEndpointDown(note) {
  return {
    id: 'synthetic:endpoint',
    name: 'Synthetic endpoint',
    provider: 'synthetic',
    kind: 'synthetic',
    via: 'synthetic',
    test: 'synthetic',
    status: 'down',
    http_status: null,
    latency_ms: null,
    note,
  };
}

async function loadTargets(env) {
  const url = `${trimSlash(env.PARAAT_API_BASE)}/api/health/agents`;
  const res = await withTimeout((signal) =>
    fetch(url, {
      method: 'GET',
      headers: { 'X-Health-Token': env.PARAAT_HEALTH_TOKEN || '', Accept: 'application/json' },
      signal,
    })
  );
  if (!res.ok) throw new Error(`health-source returned HTTP ${res.status}`);
  return res.json();
}

// ── Probe builders ───────────────────────────────────────────────────────────

function providerProbe(gateway, p, env) {
  const base = `${trimSlash(gateway.base)}/${gateway.account_id}/${gateway.gateway_id}`;
  const url = base + (p.path || '');
  const headers = {
    Accept: 'application/json',
    // AI Gateway auth — matches the app. Provider keys live in the gateway (BYOK).
    'cf-aig-authorization': env.CF_AIG_TOKEN || '',
    ...(p.headers && typeof p.headers === 'object' ? p.headers : {}),
  };
  return { id: p.id, name: p.name, provider: p.provider, kind: 'llm', via: 'gateway', url, method: p.method || 'GET', headers, agents: p.agents || [] };
}

// Direct probe for RAG + MCP agents (their endpoint URL, not the gateway).
function directProbe(r, env) {
  const headers = { Accept: 'application/json' };
  if (r.protected && env.CF_WORKER_CASE_LAW_API_KEY) {
    headers.Authorization = `Bearer ${env.CF_WORKER_CASE_LAW_API_KEY}`;
  }
  return {
    id: r.id,
    name: r.name,
    provider: r.provider,
    kind: r.kind || 'rag',
    via: 'direct',
    url: r.url,
    method: r.method || 'GET',
    headers,
    agents: r.agents || [],
    in_use: r.in_use,
  };
}

// ── Probe execution ──────────────────────────────────────────────────────────

async function runProbe(probe) {
  let outcome = await attempt(probe);

  // One retry to filter transient blips before declaring an outage.
  if (outcome.status !== 'up') {
    await sleep(RETRY_DELAY_MS);
    const retry = await attempt(probe);
    if (retry.status === 'up' || rank(retry.status) < rank(outcome.status)) outcome = retry;
    outcome.retried = true;
  }

  return {
    id: probe.id,
    name: probe.name,
    provider: probe.provider,
    kind: probe.kind,
    via: probe.via,
    url: probe.url,
    agents: probe.agents,
    ...(probe.in_use !== undefined ? { in_use: probe.in_use } : {}),
    ...outcome,
  };
}

async function attempt(probe) {
  const t0 = Date.now();
  try {
    const res = await withTimeout((signal) =>
      fetch(probe.url, { method: probe.method, headers: probe.headers, signal })
    );
    const latency = Date.now() - t0;
    return { status: classify(res.status), http_status: res.status, latency_ms: latency, note: noteFor(res.status) };
  } catch (err) {
    const latency = Date.now() - t0;
    const timedOut = err.name === 'AbortError';
    return { status: 'down', http_status: null, latency_ms: latency, note: timedOut ? 'timeout' : `network error: ${err.message}` };
  }
}

/**
 * up       — endpoint answered normally (2xx/3xx) or with an expected client
 *            response (400/404/405) proving reachability of a POST-only route.
 * degraded — reachable but auth/quota problem (401/403/429).
 * down     — server error (5xx) or no answer (network/timeout).
 */
function classify(httpStatus) {
  if (httpStatus >= 500) return 'down';
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 429) return 'degraded';
  return 'up';
}

function noteFor(httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) return 'auth rejected (check gateway token / provider key)';
  if (httpStatus === 429) return 'rate limited';
  if (httpStatus >= 500) return 'upstream server error';
  if (httpStatus === 404 || httpStatus === 405 || httpStatus === 400) return 'reachable';
  return 'ok';
}

function rank(status) {
  return { up: 0, degraded: 1, down: 2 }[status] ?? 3;
}

// ── Alerting (change-based when KV is bound, else on any outage) ──────────────

async function handleAlerts(env, results) {
  const bad = results.filter((r) => r.status !== 'up');

  if (!env.HEALTH_STATE) {
    // No KV → cannot track transitions; alert whenever something is bad.
    if (bad.length) await sendAlert(env, formatAlert(bad, [], env));
    return;
  }

  const prev = (await env.HEALTH_STATE.get('state', 'json')) || {};
  const next = {};
  const newlyBad = [];
  const recovered = [];

  for (const r of results) {
    next[r.id] = r.status;
    const was = prev[r.id];
    if (r.status !== 'up' && was !== r.status) newlyBad.push(r);
    if (r.status === 'up' && was && was !== 'up') recovered.push(r);
  }

  if (newlyBad.length || recovered.length) {
    await sendAlert(env, formatAlert(newlyBad, recovered, env));
  }
  await env.HEALTH_STATE.put('state', JSON.stringify(next));
}

async function sendAlert(env, text) {
  // Prefer posting as the Mattermost bot (reuses the existing bot token) when
  // configured; otherwise fall back to a generic incoming webhook.
  if (env.MATTERMOST_TOKEN && env.MATTERMOST_CHANNEL) {
    return sendMattermostPost(env, text);
  }
  if (!env.ALERT_WEBHOOK_URL) return;
  try {
    await withTimeout((signal) =>
      fetch(env.ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Slack-/Discord-/Mattermost-webhook-compatible payload.
        body: JSON.stringify({ text, content: text }),
        signal,
      })
    );
  } catch (_) {
    // Never let alert delivery failure break the check run.
  }
}

/**
 * Post an alert as the Mattermost bot via the REST API (POST /api/v4/posts).
 * MATTERMOST_CHANNEL may be a 26-char channel id (used directly) or a channel
 * name (resolved via MATTERMOST_TEAM). The bot must be a member of the channel.
 */
async function sendMattermostPost(env, text) {
  try {
    const base = trimSlash(env.MATTERMOST_URL || '').replace(/\/api\/v4$/, '');
    const api = `${base}/api/v4`;
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.MATTERMOST_TOKEN}`,
    };

    let channelId = env.MATTERMOST_CHANNEL;
    if (!/^[a-z0-9]{26}$/i.test(channelId) && env.MATTERMOST_TEAM) {
      const r = await withTimeout((signal) =>
        fetch(
          `${api}/teams/name/${encodeURIComponent(env.MATTERMOST_TEAM)}/channels/name/${encodeURIComponent(channelId)}`,
          { headers, signal }
        )
      );
      if (r.ok) channelId = (await r.json()).id;
    }

    await withTimeout((signal) =>
      fetch(`${api}/posts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ channel_id: channelId, message: text }),
        signal,
      })
    );
  } catch (_) {
    // Never let alert delivery failure break the check run.
  }
}

// Sanitize a value for a markdown table cell (escape pipes, flatten newlines).
function cell(s) {
  return String(s ?? '—').replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ').slice(0, 140) || '—';
}

function formatAlert(newlyBad, recovered, env) {
  const env_ = env.ENVIRONMENT ? ` [${env.ENVIRONMENT}]` : '';
  const rows = [];
  for (const r of newlyBad) {
    const emoji = r.status === 'down' ? '🔴' : '🟠';
    // A failed REAL prompt test is the serious one — chat is actually broken.
    const tag = r.test === 'synthetic' ? ' ⚠️' : '';
    rows.push(`| ${emoji}${tag} | ${cell(r.name)} | ${cell(r.provider + '/' + r.kind)} | ${cell((r.http_status ?? '—') + ' · ' + r.note)} |`);
  }
  for (const r of recovered) {
    rows.push(`| ✅ | ${cell(r.name)} | ${cell(r.provider + '/' + r.kind)} | ${cell('recovered · ' + r.latency_ms + 'ms')} |`);
  }
  // Markdown table renders in Mattermost, Slack, and Discord.
  return [
    `🩺 **Paraat endpoint health**${env_}`,
    '',
    '| | Agent | Type | Detail |',
    '|:--:|---|---|---|',
    ...rows,
  ].join('\n');
}

function formatSourceFailure(env, err) {
  const env_ = env.ENVIRONMENT ? ` [${env.ENVIRONMENT}]` : '';
  return `🔴 **Paraat endpoint health**${env_}\nCould not reach health-source (${trimSlash(env.PARAAT_API_BASE)}/api/health/agents): ${err.message}`;
}

// ── State persistence for the status view ────────────────────────────────────

async function saveLastRun(env, result) {
  if (!env.HEALTH_STATE) return;
  try {
    await env.HEALTH_STATE.put('last_run', JSON.stringify(result), { expirationTtl: 86_400 });
  } catch (_) {}
}

// ── Utilities ────────────────────────────────────────────────────────────────

function withTimeout(fn, ms = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return Promise.resolve(fn(ctrl.signal)).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
