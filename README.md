<!-- Auto-deploys to Cloudflare (Elula Online) on push to main via Workers Builds. -->
# Paraat Health Worker

A Cloudflare Worker that monitors the health of every AI endpoint Paraat depends on:

- **LLM providers** (OpenAI, Anthropic/Claude, DeepSeek, Google AI Studio/Gemini, Grok, and any others in the DB) — probed **through your Cloudflare AI Gateway** on cheap model-list endpoints, so it tests the exact path the chat pipeline uses **without spending any tokens**.
- **RAG / MCP / custom-endpoint agents** (Case Law, School Online, eGazettes, PinpointVault, etc.) — probed directly at their `ai_agents.endpoint` URL. The list is sourced **entirely from the `ai_agents` table**, so any active agent with a valid endpoint is covered automatically. Junk/invalid endpoint values (non-http, bare hostnames) are skipped so a bad DB row can't produce a fake-green result.

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

1. **Lightweight pings** (every 5 min) — reachability of the gateway, providers, RAG & MCP endpoints. Cheap, no tokens.
2. **Real end-to-end test** (`RUN_SYNTHETIC`, runs **once daily** on the `SYNTHETIC_CRON` trigger) — the worker calls `POST /api/health/synthetic`, which logs in as a real user and **sends actual prompts through the live chat pipeline**, waiting for real answers. For LLM agents the answer is produced by the queued Horizon job, so this catches the dangerous case a ping misses: **site up + users logged in, but chat silently broken** (queue/Horizon down, provider misconfigured, streaming stalled). It runs only on the daily cron to keep token spend to ~a dollar or two a month; a failed real test is tagged `⚠️REAL-TEST` in alerts. Trigger on demand any time with `GET /?synthetic=1`.

   The real test is configured on the **backend** in the DB (no `.env` needed) —
   see **Settings → Health Check** (super-admin): enable toggle, test-user email,
   and the shared token (viewable/copyable there).

Status classification:

| Result     | Meaning                                                        |
|------------|---------------------------------------------------------------|
| `up`       | 2xx/3xx, or an expected 400/404/405 (endpoint reachable)      |
| `degraded` | 401 / 403 (auth) or 429 (rate limited) — reachable but broken |
| `down`     | 5xx, timeout, or network error (retried once first)          |

## The backend side (added to paraat-backend)

- `GET /api/health/agents` and `POST /api/health/synthetic` → `HealthCheckController`, guarded by the `health.token` middleware.
- Config lives in the **database** (Spatie Settings), managed at **Settings → Health Check** (super-admin): shared token, synthetic on/off, and the test-user email. No `.env` needed. (Run `php artisan migrate` once to create the settings.)
- No provider API keys are ever returned by these endpoints — they only say *what* to check.

> **Deploy order:** the endpoints only exist once the backend change is merged and deployed to that environment. Point `PARAAT_API_BASE` at an environment **after** it has the code, or every check returns 404.

## Current deployment

- **Worker:** `https://paraat-health-worker.elula.workers.dev` (Cloudflare account **Elula Online**, `2f3a5428…`)
- **Source:** `elula-online/paraat-health-worker` (`main`) — **auto-deploys on push** via Workers Builds
- **KV:** `HEALTH_STATE` bound (change-based alerts + `/` status view)
- **Secrets set:** `PARAAT_API_BASE` = `https://uatsole.paraat.ai` (dev/UAT), `ENVIRONMENT` = `uat`, `CF_AIG_TOKEN`
- **Not set yet:** `MATTERMOST_TOKEN` → alerts are off until it's set (no spam while the backend endpoints aren't live)
- **To point at live:** `printf '%s' "https://console.paraat.ai" | wrangler secret put PARAAT_API_BASE` (and set `ENVIRONMENT` = `production`)

> The worker returns HTTP 503 with `health-source returned HTTP 404` until the backend health endpoints (`/api/health/agents`, `/api/health/synthetic`) are deployed to the target URL — those ship in paraat-backend MR #374.

## Environment variables

> **This worker has its own isolated environment** — it does **not** inherit the Paraat backend's `.env` or the `paraatmaster` worker's secrets. Every value below must be set on *this* worker (Cloudflare dashboard → your Worker → Settings → Variables, or `wrangler secret put`).

| Name | Kind | Required | Purpose |
|------|------|----------|---------|
| `PARAAT_API_BASE` | **secret** | **yes** | Backend URL to monitor — `https://console.paraat.ai` (live) or `https://uatsole.paraat.ai` (dev). Set as a secret (not in `wrangler.toml`) so it isn't hardcoded. |
| `PARAAT_HEALTH_TOKEN` | secret | **yes** | Must match the backend's health-check token (Settings → Health Check). |
| `CF_AIG_TOKEN` | secret | for LLM pings | CF AI Gateway token — same as backend's `CF_AIGETWAY_AIG_AUTH_MAIN`. Enables the provider `/v1/models` pings. |
| `ALERT_WEBHOOK_URL` | secret | one of these | Incoming webhook (Mattermost/Slack/Discord/Google Chat). **Blank + no bot = no alerts.** |
| `MATTERMOST_TOKEN` | secret | alt to webhook | Post as the Mattermost bot via the REST API instead of a webhook. If set with `MATTERMOST_CHANNEL`, this is used and `ALERT_WEBHOOK_URL` is ignored. |
| `MATTERMOST_URL` / `MATTERMOST_TEAM` / `MATTERMOST_CHANNEL` | var | with bot token | Server (`https://matter.elula.cloud`), team, and channel (id, or name + team) for bot posts. |
| `CF_WORKER_CASE_LAW_API_KEY` | secret | optional | Only authenticates the Case Law ping. **Leave blank** — it's still pinged for reachability. |
| `STATUS_TOKEN` | secret | optional | Password for the status URL (`GET /`) and on-demand runs (`/?synthetic=1`). Blank = anyone with the URL can trigger a paid run, so setting a random value is recommended. |
| `RUN_SYNTHETIC` | var | default `true` | Master switch for the real test. |
| `SYNTHETIC_CRON` | var | default `0 6 * * *` | Which cron trigger runs the real test (keep in sync with `[triggers]`). |
| `SYNTHETIC_TIMEOUT_MS` | var | default `150000` | Max wait for the synthetic run (MCP agents are slow). |
| `ENVIRONMENT` | secret | optional | Label shown in alerts (e.g. `production`). Set as a secret so it's not hardcoded. |

## Setup

**Option A — Cloudflare dashboard (deploy from Git):** connect this repo and deploy. Then set the **secrets** (Settings → Variables and Secrets → Encrypt): `PARAAT_API_BASE` (the backend URL you're monitoring), `ENVIRONMENT`, `MATTERMOST_TOKEN`, `CF_AIG_TOKEN`. Everything else (crons, Mattermost URL/team/channel, synthetic settings, KV binding) comes from `wrangler.toml`.

**Option B — CLI:**
```bash
cd paraat-health-worker
npm install
wrangler secret put PARAAT_API_BASE        # e.g. https://uatsole.paraat.ai (dev) / https://console.paraat.ai (live)
wrangler secret put ENVIRONMENT            # e.g. uat / production
wrangler secret put CF_AIG_TOKEN
wrangler secret put MATTERMOST_TOKEN       # for alerts
npm run deploy
```

**(Recommended) KV for change-based alerts + status view:**
```bash
wrangler kv namespace create HEALTH_STATE
```
Paste the returned `id` into the `[[kv_namespaces]]` block in `wrangler.toml` and uncomment it. Without KV, the worker alerts on **every** run where something is down (noisier).

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real values
npm run dev
# then hit http://localhost:8787/?alert=1 to run a check and see JSON
```

## On-demand check

`GET https://<your-worker>.workers.dev/` runs a check and returns JSON (HTTP 503 if anything is down/degraded). Add `?alert=1` to also fire alerts. If `STATUS_TOKEN` is set, pass `?token=...` or header `x-status-token`.

## Alerts

Two ways to deliver alerts — pick one:

**A) Mattermost bot (reuses your existing bot — no webhook needed)**
Set `MATTERMOST_TOKEN` (secret) plus `MATTERMOST_URL`, `MATTERMOST_TEAM`, `MATTERMOST_CHANNEL` (vars). The worker posts via `POST /api/v4/posts` as the bot. `MATTERMOST_CHANNEL` can be a 26-char channel id or a channel name (resolved via team). The bot must be a member of the channel.

**B) Incoming webhook**
Set `ALERT_WEBHOOK_URL` to an incoming webhook. The payload is `{ text, content }` with `**bold**` markdown, which works with **Mattermost**, **Slack**, **Discord**, and **Google Chat**. For Mattermost: enable incoming webhooks (System Console → Integrations), then *Integrations → Incoming Webhooks → Add* and copy the `https://<server>/hooks/…` URL.

If both are configured, the bot (A) wins. **Microsoft Teams** needs a different payload (Adaptive Card) — adapt `sendAlert()`. For **email**, replace `sendAlert()` with a mail-API call — it's a single isolated function.
