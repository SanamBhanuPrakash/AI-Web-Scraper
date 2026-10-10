# Deployment guide (Vercel, free)

This takes about 15 minutes and costs nothing. When you finish you have a public `https://<name>.vercel.app` link that serves the web app and the API from one project, and every `git push` redeploys it.

**Why Vercel and not Render or Fly.** One project serves the static web app and the API function. Render's free web service sleeps after 15 minutes idle and takes 30 to 60 seconds to wake, which makes a demo look broken. Fly needs a card and a container. Vercel needs neither, and the Hobby plan's function limits (up to 5 minutes with Fluid compute) comfortably cover the 50 second request deadline.

**What is already verified (and what is not).** The Vercel entry (`api/[...path].ts`) follows the documented `export default { fetch }` shape. I ran Vercel's own builder locally (`vercel build`), then ran the built function in an isolated folder: health, OpenAPI, SSRF blocking and a full Detailed summary all worked. That caught and fixed two real problems (see "How the function is packaged"). What cannot be verified before deploying is your account, your keys and Vercel's network, so the checks in step 7 matter.

---

## 0. What you need

| Item                       | Where                      | Notes                                                                       |
| -------------------------- | -------------------------- | --------------------------------------------------------------------------- |
| GitHub repository (public) | github.com                 | The assignment needs it public. Vercel will deploy from it.                 |
| Vercel account             | vercel.com/signup          | Sign up with GitHub. Choose the **Hobby** plan (free, no card).             |
| Gemini API key             | aistudio.google.com/apikey | Free, no card.                                                              |
| Groq API key               | console.groq.com/keys      | Free, no card. Optional but recommended (fallback and fast path for Quick). |
| Upstash Redis (optional)   | console.upstash.com        | Free. Makes the rate limit and cache shared across serverless instances.    |

Before you start, on your machine:

```bash
npm run check          # lint, types, 500+ tests; must be green
git status             # nothing uncommitted that you want deployed
git push               # the latest code must be on GitHub
```

## 1. Use fresh API keys

Earlier in this project keys were pasted into a committed file. They were removed from the history, but treat them as exposed.

1. Google AI Studio, **Create API key**, copy it. Then delete the old key.
2. Groq console, **Create API Key**, copy it. Then delete the old key.
3. Update your local `.env` with the new values so local runs keep working.

Keep the new keys in a password manager. They go into Vercel (step 4), never into the repository.

## 2. Create the Vercel project from GitHub

1. Go to **vercel.com/new**.
2. Under **Import Git Repository**, click **Adjust GitHub App Permissions** (or **Install**) if your repository is not listed. Choose **Only select repositories** and pick this repository. Return to Vercel and click **Import** next to it.
3. On the **Configure Project** screen:

| Setting                | Value                   | Why                                                                                                                                                                                                        |
| ---------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project Name           | anything, e.g. `digest` | Becomes `digest.vercel.app` (a suffix is added if the name is taken).                                                                                                                                      |
| Framework Preset       | **Other**               | The repo is a Vite app plus a Hono function, not Next.js.                                                                                                                                                  |
| Root Directory         | `./` (repository root)  | The API function lives in `/api` at the root. Do not point this at `apps/web`.                                                                                                                             |
| Build, Install, Output | leave as shown          | They come from `vercel.json`: install `npm install`, build `npm run build`, output `apps/web/dist`. If the fields show those values (possibly greyed out as "overridden by vercel.json"), that is correct. |
| Node.js Version        | 22.x or newer           | `package.json` declares `"node": ">=22"`. If the project settings offer a version list, pick 22.x.                                                                                                         |

4. **Do not click Deploy yet.** Open **Environment Variables** on the same screen (next step).

## 3. Environment variables

Add these in **Environment Variables** on the Configure screen (or later at **Project, Settings, Environment Variables**). Add each to **Production** and **Preview**, and turn on **Sensitive** for the keys so they cannot be read back in the dashboard (Vercel does not allow Sensitive variables in the Development scope; your local `.env` covers that).

| Name                       | Value                 | Required      |
| -------------------------- | --------------------- | ------------- |
| `GEMINI_API_KEY`           | your new Gemini key   | Yes (or Groq) |
| `GROQ_API_KEY`             | your new Groq key     | Recommended   |
| `UPSTASH_REDIS_REST_URL`   | from Upstash (step 8) | Optional      |
| `UPSTASH_REDIS_REST_TOKEN` | from Upstash (step 8) | Optional      |

You do **not** need to set `TRUST_PROXY` (it turns on automatically on Vercel so client IPs come from Vercel's header) or `PORT`. The other settings in `.env.example` have sensible defaults; change them only if you have a reason (for example `RATE_LIMIT_PER_MIN`). Do not set `DIGEST_MOCK_LLM` in production: it replaces the real model with the offline demo summarizer.

> If neither AI key is set, the function refuses to start (a deliberate guard) and every `/api` call returns an error. Step 7 shows how to recognize that.

## 4. Deploy

Click **Deploy**. Watch the build log. You should see, in order:

1. `Running "install" command: npm install`
2. `Running "npm run build"`: this builds the web app (`tsc` then `vite build`).
3. Detection of the Function `api/[...path].ts`.
4. `Build Completed`, then **Congratulations**, with a screenshot of your site.

First deploys take 1 to 3 minutes. Click **Continue to Dashboard**, then **Visit** to open the production URL.

## 5. Make sure the site is public

Vercel can put a login in front of deployments (**Deployment Protection**). For a link you submit to reviewers, production must be public.

1. Open the production URL in a **private/incognito window**.
2. If you see the app, you are done with this step.
3. If you see a Vercel login page: **Project, Settings, Deployment Protection**, set **Vercel Authentication** to protect **Preview deployments only** (or turn it off), save, and test again.

## 6. Smoke test from a terminal

Replace `YOUR-APP` with your domain.

```bash
# 1. Is the function running, and which providers did it find?
curl https://YOUR-APP.vercel.app/api/health
# expect: {"ok":true,...,"providers":{"gemini":true,"groq":true,"mock":false,"active":["gemini","groq"]},...}

# 2. A real summary (quick, JSON)
curl -X POST https://YOUR-APP.vercel.app/api/summarize \
  -H 'content-type: application/json' \
  -d '{"url":"https://en.wikipedia.org/wiki/Web_scraping","length":"short"}'

# 3. A detailed brief, streamed
curl -N -X POST https://YOUR-APP.vercel.app/api/summarize \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"url":"https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview","length":"detailed"}'
# expect events: phase, meta, phase, analysis, phase, tldr, point..., done

# 4. The safety net: this must be refused
curl -X POST https://YOUR-APP.vercel.app/api/summarize \
  -H 'content-type: application/json' -d '{"url":"http://169.254.169.254/latest/meta-data"}'
# expect HTTP 400 and "blocked_url"
```

## 7. Test in the browser

1. Open the production URL. The first screen shows a real sample brief.
2. Paste a link (try one of the three examples), keep **Detailed**, click **Summarize**. You should see three steps, the sections it found, then the brief streaming in.
3. Click a **Source** pill: the quote and its paragraph appear, highlighted.
4. Try **Quick**, the theme toggle, **Copy summary** and **Download .md**.
5. Open DevTools, Network, click the document request, and confirm the response headers include `Content-Security-Policy`, `X-Content-Type-Options` and `Strict-Transport-Security`.

### If something is wrong

| Symptom                                                                    | Likely cause                                               | Fix                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/health` returns HTTP 500, or the app says the service is unavailable | No AI key reached the function                             | Add `GEMINI_API_KEY` and/or `GROQ_API_KEY` (step 3), then **Deployments, the latest one, the three dots, Redeploy**. Environment changes apply only to new deployments. |
| `/api/health` shows `"providers":{"mock":true}`                            | `DIGEST_MOCK_LLM=1` is set                                 | Remove that variable and redeploy.                                                                                                                                      |
| Build fails at `npm install` or on the Node version                        | Node older than 22                                         | **Settings, General, Node.js Version**: choose 22.x or newer, redeploy.                                                                                                 |
| Build fails with a TypeScript error                                        | A type error in the code                                   | Run `npm run typecheck` locally, fix, push.                                                                                                                             |
| `/api/...` returns 404                                                     | The function was not detected                              | Confirm `api/[...path].ts` exists at the repository root and Root Directory is `./`.                                                                                    |
| Login page in a private window                                             | Deployment Protection                                      | Step 5.                                                                                                                                                                 |
| "AI capacity reached for now"                                              | Free quota used up on both providers                       | Wait the stated time; Quick uses roughly half the quota of Detailed.                                                                                                    |
| Detailed often says "standard" in the footer details                       | The reading pass was unusable and it fell back to one pass | See `docs/runbook.md`; check the logs (below).                                                                                                                          |
| Summaries time out around 50 s                                             | Slow site plus slow model                                  | Retry; Quick is faster.                                                                                                                                                 |

**Where the logs are.** **Project, Logs** (runtime logs). Each request is one JSON line with the request id, host, timings, provider and grounded count. Keys, full URLs and page text are never logged. To find one failing request, search for its `requestId` (shown in the error's "Details for support").

## 8. Optional: shared rate limit and cache (Upstash, free)

Without it, each serverless instance counts requests on its own, so the per-client limit is best effort. With it the limit and cache are global.

1. console.upstash.com, sign up, **Create Database**, type **Redis**, name it, pick the region closest to your Vercel function (the default function region is `iad1`, US East), choose the **Free** plan.
2. Open the database, find the **REST API** section, and copy **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN**. Use the REST values, not the `redis://` connection string.
3. Add both as environment variables in Vercel (step 3), then **Redeploy**.
4. Check `curl https://YOUR-APP.vercel.app/api/health`: it should now say `"sharedStore":true`.

(You can also create it from the Vercel dashboard: **Storage, Create Database, Upstash**. Use whichever you prefer; the variable names the app reads are the two above.)

## 9. Day-to-day

| Task                      | How                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Ship a change             | `git push` to `main`. Vercel builds and promotes it to production automatically.                                                    |
| Try a change safely       | Push a branch or open a pull request: Vercel gives it a Preview URL (Preview needs the same env vars; step 3 adds them to Preview). |
| Change a key or setting   | Edit it in **Settings, Environment Variables**, then **Redeploy** (changes are not applied to old deployments).                     |
| Roll back                 | **Deployments**, open a previous good one, **Promote to Production** (or the three dots, **Instant Rollback**).                     |
| Custom domain             | **Settings, Domains, Add**. Follow the DNS instructions; HTTPS is automatic.                                                        |
| From the terminal instead | `npx vercel login`, `npx vercel` (links and makes a preview), `npx vercel env add GEMINI_API_KEY production`, `npx vercel --prod`.  |

## 10. Finish the assignment

1. Put the live URL in the README: edit the line "Deployed live link" in the table near the top (`README.md`) to a real link, for example `https://YOUR-APP.vercel.app`.
2. Commit and push: `git add README.md`, `git commit -m "docs: add live link"`, `git push`.
3. Submit: the public GitHub repository URL and the live link.
4. Reviewer checklist (all true): the repository is public; the README says how to run the frontend and backend and where `.env` goes; `.env` is not in the repository (`git ls-files | grep -x .env` prints nothing); the live link opens without a login; one real summary works.

## 11. Limits to know about

- **Free tiers.** Vercel Hobby is for personal, non-commercial use. Gemini and Groq free quotas change and are shared by everyone using your link: a burst of visitors can exhaust them. The UI says so with a wait time instead of failing silently.
- **Cost.** No card is needed for Vercel Hobby, Gemini, Groq or Upstash free, so nothing can be billed to you. If a free limit is reached, the affected feature stops or slows until the limit resets. Check each provider's current limits, because free tiers change.
- **Security.** Never commit `.env`. If a key leaks, rotate it first, then fix the repository.
- **robots.txt and sites that block bots.** Some sites (for example news sites behind a bot wall) return 403 to any automated fetch from a data center. Digest reports this plainly; it is not a deployment problem.

---

## How the function is packaged (for the curious, and for future you)

Vercel turns `api/[...path].ts` into one Node function. Two things matter, both found by running Vercel's builder locally:

1. **TypeScript settings.** Vercel type-checks the function with its own defaults unless the repository has a root `tsconfig.json`. Without one it rejected `Error.cause` and `Intl.Segmenter` (ES2022 features). The root `tsconfig.json` points it at the same ES2023 settings the project uses everywhere.
2. **The shared package.** `@digest/shared` is a workspace package whose entry is TypeScript source. A serverless build links workspace packages under `node_modules`, and Node will not load TypeScript from `node_modules`. API code therefore imports the shared types through `apps/api/src/shared.ts`, a plain relative import that is compiled with everything else. `npm run hygiene` fails if any API or function file imports `@digest/shared` by name, so this cannot silently regress. The web app is unaffected because Vite handles it.

To reproduce the local proof: `npx vercel build` needs a linked project (`npx vercel link` after `npx vercel login`), then run the files under `.vercel/output/functions/api/[...path].func` with Node in a folder outside the repository.
