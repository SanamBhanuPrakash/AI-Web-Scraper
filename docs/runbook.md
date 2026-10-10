# Runbook

Symptom, likely cause, action. Everything here works with free tiers only.

## Quick diagnosis

```bash
curl https://<your-app>.vercel.app/api/health
```

Shows which providers have keys (`gemini`, `groq`), the active order, and whether the shared store (Upstash) is enabled. In Vercel, **Logs** shows one JSON line per request (`msg":"request"`) with `errorCode`, `provider`, `fallback`, `cached` and per-stage `timingsMs`.

## Symptoms

| Symptom                                                                         | Likely cause                                                                               | Action                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every summary fails with "The summarizer is unavailable"                        | Missing or invalid API key, or retired model id                                            | Check `/api/health`. Verify the key in Vercel env vars. Look for `ai_unavailable` with `detail` `404` or `400` in logs: set `GEMINI_MODEL` or `GROQ_MODEL` to a current model (list them with the provider's models endpoint) and redeploy. |
| "AI capacity reached for now"                                                   | Free quota exhausted on both providers                                                     | Wait for the advertised time (daily limits reset at midnight Pacific for Gemini). Optionally add a second provider key. Check the cache is on (Upstash) so repeats do not spend quota.                                                      |
| Summaries are slow (6 s and more)                                               | Gemini latency spike, long page                                                            | Lower `FIRST_TOKEN_TIMEOUT_MS`, confirm `LLM_ROUTING=size-aware`, make sure `GROQ_API_KEY` is set so small pages use the fast provider.                                                                                                     |
| Many `429` for real users                                                       | Rate limit too tight or per-instance counting                                              | Raise `RATE_LIMIT_PER_MIN`; add Upstash so the limit is global instead of per instance.                                                                                                                                                     |
| "The site blocked the request" for a popular site                               | The site blocks automated clients (HTTP 403, challenge page)                               | Expected. Digest identifies itself honestly and does not evade bot protection.                                                                                                                                                              |
| "This page needs JavaScript" for a page that looks fine in a browser            | Content is rendered client-side                                                            | Expected; try the article or AMP URL.                                                                                                                                                                                                       |
| Detailed briefs are slow (15 s and more) or often come back as a normal summary | Gemini slow on the reading pass, or notes failed verification (`mode: standard` in `meta`) | Check logs for `read pass` (findings, verified, dropped); a high drop count means the model is not copying quotes exactly. Quick is the fast path.                                                                                          |
| 504 `request_timeout`                                                           | Slow site plus slow model near the 50 s request deadline                                   | Retry; check the `timingsMs` split in logs.                                                                                                                                                                                                 |
| Build fails on Vercel                                                           | Missing install or wrong root                                                              | Root Directory must be the repository root; build settings come from `vercel.json`.                                                                                                                                                         |
| Frontend loads but API calls fail                                               | Function not deployed or env validation failed at boot                                     | Open `/api/health`; the function logs show `Invalid environment configuration` or `No AI provider configured`.                                                                                                                              |
| Page text appears garbled                                                       | Unusual charset                                                                            | Check `extractionMethod` and `confidence` in the response; charset is read from header, BOM, then `<meta>`.                                                                                                                                 |

## Rotating an API key

1. Create the new key at Google AI Studio or the Groq console.
2. In Vercel, **Settings, Environment Variables**: update the value, then **Redeploy** (env changes need a new deployment).
3. Revoke the old key at the provider.
4. Locally, update `.env`. Never paste keys into issues, chats, or `.env.example`.

If a key was ever committed: rotate it first, then remove it from history before pushing. `npm run hygiene` scans for key patterns before every commit.

## Changing models

Models are configuration, not code: set `GEMINI_MODEL` / `GROQ_MODEL`. Verify a model with a one-off streaming call before switching (`npm run smoke -w @digest/api -- <url>` uses the configured models). Avoid "reasoning" models with small token budgets: they can spend the whole budget thinking and return nothing.

## Enabling the shared cache and rate limit

Create a free Upstash Redis database, copy the REST URL and token into `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, redeploy. `/api/health` then reports `sharedStore: true`. If Redis is unreachable the app silently falls back to memory.

## Rollback

Vercel keeps previous deployments: **Deployments, (previous good one), Promote to Production**. No rebuild needed.

## Verifying a release

```bash
npm run check      # hygiene, secret scan, lint, strict types, 420+ unit and integration tests
npm run e2e        # real-browser flows, axe accessibility audits, strict CSP
npm run smoke -w @digest/api -- https://en.wikipedia.org/wiki/Web_scraping   # live, needs keys
```

After deploying: open the production URL in a private window, summarize one example link, expand a passage, switch theme, and check `/api/health`.

## Load test

Never against real AI quotas or third-party sites. Use the fixture server with the mock summarizer:

```bash
npm run e2e-server -w @digest/api                 # terminal 1
API_URL=http://localhost:8790 node scripts/burst.mjs 200 50 unique   # terminal 2
```
