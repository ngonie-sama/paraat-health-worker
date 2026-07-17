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

## Environment variables

> **This worker has its own isolated environment** — it does **not** inherit the Paraat backend's `.env` or the `paraatmaster` worker's secrets. Every value below must be set on *this* worker (Cloudflare dashboard → your Worker → Settings → Variables, or `wrangler secret put`).

| Name | Kind | Required | Purpose |
|------|------|----------|---------|
| `PARAAT_API_BASE` | var | **yes** | Your backend URL, e.g. `https://dev.paraat.ai`. **Change the placeholder.** |
| `PARAAT_HEALTH_TOKEN` | secret | **yes** | Must match the backend's health-check token (Settings → Health Check). |
| `CF_AIG_TOKEN` | secret | for LLM pings | CF AI Gateway token — same as backend's `CF_AIGETWAY_AIG_AUTH_MAIN`. Enables the provider `/v1/models` pings. |
| `ALERT_WEBHOOK_URL` | secret | recommended | Slack/Discord incoming webhook. **Blank = no alerts fire.** |
| `CF_WORKER_CASE_LAW_API_KEY` | secret | optional | Only authenticates the Case Law ping. **Leave blank** — it's still pinged for reachability. |
| `STATUS_TOKEN` | secret | optional | Password for the status URL (`GET /`) and on-demand runs (`/?synthetic=1`). Blank = anyone with the URL can trigger a paid run, so setting a random value is recommended. |
| `RUN_SYNTHETIC` | var | default `true` | Master switch for the real test. |
| `SYNTHETIC_CRON` | var | default `0 6 * * *` | Which cron trigger runs the real test (keep in sync with `[triggers]`). |
| `SYNTHETIC_TIMEOUT_MS` | var | default `150000` | Max wait for the synthetic run (MCP agents are slow). |
| `ENVIRONMENT` | var | optional | Label shown in alerts, e.g. `production`. |

## Setup

**Option A — Cloudflare dashboard (deploy from Git):** connect this repo, then fill the variables above in the setup screen. Set `PARAAT_API_BASE` to your real backend URL; leave the optional secrets blank if you don't need them.

**Option B — CLI:**
```bash
cd paraat-health-worker
npm install
# set PARAAT_API_BASE (+ cron) in wrangler.toml, then:
wrangler secret put PARAAT_HEALTH_TOKEN
wrangler secret put CF_AIG_TOKEN
wrangler secret put ALERT_WEBHOOK_URL      # optional
wrangler secret put STATUS_TOKEN           # optional
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

Set `ALERT_WEBHOOK_URL` to an incoming webhook. The payload is `{ text, content }` with `**bold**` markdown, which works out of the box with **Mattermost**, **Slack**, **Discord**, and **Google Chat**.

- **Mattermost**: enable incoming webhooks (System Console → Integrations), then *Integrations → Incoming Webhooks → Add* and copy the `https://<server>/hooks/…` URL.
- **Microsoft Teams** needs a different payload (Adaptive Card) — adapt `sendAlert()` in `src/index.js`.
- For **email**, replace `sendAlert()` with a call to your mail API (Resend/SendGrid/MailChannels) — it's a single isolated function.
