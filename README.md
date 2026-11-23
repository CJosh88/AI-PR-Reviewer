# pr-reviewer

An AI code reviewer for GitHub pull requests, running on Cloudflare Workers.

Every push to an open pull request is reviewed automatically. The bot posts a review with inline comments
and sets an **AI review** status check. The check fails if the review finds a blocker, so it can be used
to stop risky code from being merged.

## How it works

```
push to PR ─► GitHub App webhook ─► Worker (/webhook)
                                       │  verifies signature
                                       ▼
                       Durable Object (one per pull request)
                         • waits for pushes to settle (debounce)
                         • fetches the diff from GitHub
                         • asks the model for a review
                         • posts the review + completes the "AI review" check
```

- **Model:** Workers AI (runs on Cloudflare) or Claude via the Anthropic API, chosen with one setting.
- **Every commit is covered.** Pushes are debounced, so a burst of commits gets one review of the newest commit. A review that a newer push overtakes is discarded rather than posted.
- **Noise is filtered.** Lockfiles, generated, minified, vendored and binary files are skipped, and a finding already raised on the same line isn't repeated.
- **No dependencies** beyond Wrangler. GitHub App auth, webhook verification and the GitHub API client are in `src/lib.ts`.

## Project layout

| File | Purpose |
|---|---|
| `src/index.ts` | Webhook handler and the per-PR reviewer (Durable Object) |
| `src/lib.ts` | GitHub auth, diff preparation, prompts, output parsing |
| `wrangler.jsonc` | Worker config, bindings and settings |

## Setup

### 1. Create a GitHub App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**

- **Homepage URL:** this repo's URL
- **Webhook URL:** `https://<worker-name>.<your-subdomain>.workers.dev/webhook`
- **Webhook secret:** a random string (keep it for step 3)
- **Repository permissions:** Pull requests: Read & write. Contents: Read. Checks: Read & write. Metadata: Read.
- **Subscribe to events:** Pull request, Check run
- **Where can this app be installed:** Only on this account

After you create it, note the **App ID**, click **Generate a private key** (downloads a `.pem` file),
and **Install App** on the repositories you want reviewed.

### 2. Deploy the Worker

```bash
npm install
npx wrangler login
npx wrangler deploy
```

### 3. Add secrets

Run these from the project folder:

```bash
npx wrangler secret put WEBHOOK_SECRET      # same value as the GitHub App's webhook secret
npx wrangler secret put GITHUB_APP_ID       # the App ID number
npx wrangler secret put ANTHROPIC_API_KEY   # only if MODEL_PROVIDER is "anthropic"

# Private key: pipe the file in so line breaks are preserved
npx wrangler secret put GITHUB_PRIVATE_KEY < path/to/app.private-key.pem
# PowerShell:
# Get-Content "path\to\app.private-key.pem" -Raw | npx wrangler secret put GITHUB_PRIVATE_KEY
```

GitHub's `.pem` file works as is. No format conversion is needed.

### 4. Require the check (optional)

Repo → Settings → Rules → Rulesets → new branch ruleset for the default branch:

- **Require a pull request before merging.** Set required approvals to `0` if you work alone; the bot comments but never approves.
- **Require status checks to pass:** add **AI review**. It appears in the list after the bot has run once.

## Configuration

Set these under `vars` in `wrangler.jsonc`, then redeploy.

| Variable | Default | Description |
|---|---|---|
| `MODEL_PROVIDER` | `anthropic` | `anthropic` or `workers-ai` |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Claude model used with `anthropic` |
| `WORKERS_AI_MODEL` | `@cf/google/gemma-4-26b-a4b-it` | Workers AI model used with `workers-ai` |
| `CHECK_NAME` | `AI review` | Name of the status check |
| `DEBOUNCE_SECONDS` | `20` | Quiet period after a push before reviewing |
| `MAX_DIFF_CHARS` | `120000` | Diff size sent to the model; use about `40000` for small models |
| `MAX_INLINE_COMMENTS` | `20` | Extra findings are listed in the review body |
| `BLOCK_ON_BLOCKERS` | `true` | Fail the check when a blocker is found; `false` = advisory only |
| `SKIP_LABEL` | `skip-ai-review` | PRs with this label are not reviewed |

## Usage

- **Re-run a review:** PR → Checks tab → AI review → Re-run
- **Skip a PR:** add the `skip-ai-review` label
- **Drafts** are skipped until marked ready for review
- **Repo-specific rules:** add `.github/ai-review.md` (or `REVIEW.md`, `CLAUDE.md`, `AGENTS.md`) to a reviewed repo. The reviewer reads it from the PR's latest commit and applies it.

Findings are marked 🛑 **blocker**, ⚠️ **warning** or 💬 **nit**.

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing happens on a PR | GitHub App → Advanced → **Recent Deliveries**. Is the webhook being sent? |
| Delivery shows `401 Invalid signature` | `WEBHOOK_SECRET` doesn't match the App's webhook secret |
| Delivery shows `ignored` | The PR is a draft, closed, or has the skip label |
| Check fails with "AI review could not run" | The error is in the check details. Also run `npx wrangler tail` while pushing a commit |
| Worker URL shows "Hello World!" | The latest code isn't deployed. Run `npx wrangler deploy` from the project folder |

## Security

- Secrets live in Cloudflare (`wrangler secret put`), never in this repo. Don't commit `.pem` files or `.dev.vars`.
- Every webhook is verified against `WEBHOOK_SECRET` before it is processed.
- The GitHub App uses short-lived installation tokens scoped to the repositories it's installed on.
- PR titles, descriptions and diffs are treated as untrusted input. The prompt tells the model not to follow instructions found in them.
- AI reviews can be wrong in both directions. Treat them as a first pass, not a replacement for human judgement.
