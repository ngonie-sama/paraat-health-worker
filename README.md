# Paraat Health Worker

A Cloudflare Worker that monitors the health of every AI endpoint Paraat depends on:

- **LLM providers** (OpenAI, Anthropic/Claude, DeepSeek, Google AI Studio/Gemini, Grok, and any others in the DB) — probed **through your Cloudflare AI Gateway** on cheap model-list endpoints, so it tests the exact path the chat pipeline uses **without spending any tokens**.
- **RAG / custom agents** (e.g. Case Law) and DB-driven MCP agents (`pinpoint_vault`, `n8n_db`, `gitlab_mcp`, `mattermost`, `thinkstein`) — probed directly at their `ai_agents.endpoint` URL.
- **Hardcoded MCP agents** (School Online, Land Claims Court, eGazettes, Vecflow) — their worker URLs live in the PHP service classes, not the DB, so they are registered in `config/services.php` under `health_check.mcp_agents` and probed directly. Each carries an `in_use` flag = whether an active `ai_agents` row exists for it.

The target list is pulled **live** from the Paraat backend, so new agents/providers are picked up automatically — nothing to redeploy when the DB changes.

## How it works

```
cron ─▶ GET {PARAAT_API_BASE}/api/health/agents   (X-Health-Token)
          │  returns: gateway routing + deduped provider probes + RAG endpoints
          ▼
     probe each (authenticated ping, 10s timeout, 1 retry)
          │  LLM  → gateway.ai.cloudflare.com/.../{provider}/...models   (cf-aig-authorization)
          │  RAG  → the agent's endpoint URL
          ▼
     classify up / degraded / down  ─▶  alert on change (Slack/Discord/webhook)
```

### Two layers of checking

1. **Lightweight pings** (every run) — reachability of the gateway, providers, RAG & MCP endpoints. Cheap, no tokens.
2. **Real end-to-end test** (`RUN_SYNTHETIC`) — the worker calls `POST /api/health/synthetic`, which logs in as a real user and **sends actual prompts through the live chat pipeline**, waiting for real answers. For LLM agents the answer is produced by the queued Horizon job, so this catches the dangerous case a ping misses: **site up + users logged in, but chat silently broken** (queue/Horizon down, provider misconfigured, streaming stalled). Throttle it with `SYNTHETIC_EVERY_N_RUNS` to control token spend; a failed real test is tagged `⚠️REAL-TEST` in alerts.

   Backend `.env` for the real test:
   ```
   HEALTH_SYNTHETIC_ENABLED=true
   HEALTH_CHECK_USER_EMAIL=<existing user with a company + agent access>
   # optional tuning: HEALTH_SYNTHETIC_TIMEOUT, HEALTH_MODEL_OPENAI, HEALTH_MODEL_ANTHROPIC, ...
   ```

Status classification:

| Result     | Meaning                                                        |
|------------|---------------------------------------------------------------|
| `up`       | 2xx/3xx, or an expected 400/404/405 (endpoint reachable)      |
| `degraded` | 401 / 403 (auth) or 429 (rate limited) — reachable but broken |
| `down`     | 5xx, timeout, or network error (retried once first)          |

## The backend side (already added to paraat-backend)

- `GET /api/health/agents` → `HealthCheckController` (guarded by `health.token` middleware)
- Set the shared secret in the Laravel `.env`:

  ```
  HEALTH_CHECK_TOKEN=<long-random-string>
  ```
  Then `php artisan config:clear`.

No provider API keys are ever returned by this endpoint — it only says *what* to check.

## Setup

```bash
cd paraat-health-worker
npm install
```

1. Edit `wrangler.toml` → set `PARAAT_API_BASE` to your backend URL and adjust the cron.

2. Set secrets (production):

   ```bash
   wrangler secret put PARAAT_HEALTH_TOKEN          # == HEALTH_CHECK_TOKEN in Laravel .env
   wrangler secret put CF_AIG_TOKEN                 # == CF_AIGETWAY_AIG_AUTH_MAIN in Laravel .env
   wrangler secret put ALERT_WEBHOOK_URL            # optional: Slack/Discord/webhook
   wrangler secret put CF_WORKER_CASE_LAW_API_KEY   # optional: for protected RAG endpoints
   wrangler secret put STATUS_TOKEN                 # optional: protects the GET / status view
   ```

3. (Recommended) Enable change-based alerts + status caching with KV:

   ```bash
   wrangler kv namespace create HEALTH_STATE
   ```
   Paste the returned `id` into the `[[kv_namespaces]]` block in `wrangler.toml` and uncomment it.
   Without KV, the worker alerts on **every** run where something is down (noisier).

4. Deploy:

   ```bash
   npm run deploy
   ```

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real values
npm run dev
# then hit http://localhost:8787/?alert=1 to run a check and see JSON
```

## On-demand check

`GET https://<your-worker>.workers.dev/` runs a check and returns JSON (HTTP 503 if anything is down/degraded). Add `?alert=1` to also fire alerts. If `STATUS_TOKEN` is set, pass `?token=...` or header `x-status-token`.

## Alerts

Set `ALERT_WEBHOOK_URL` to a Slack or Discord incoming-webhook (the payload includes both `text` and `content` for compatibility). To use email instead, replace `sendAlert()` in `src/index.js` with a call to your mail API (e.g. Resend/SendGrid/MailChannels) — it's a single isolated function.
