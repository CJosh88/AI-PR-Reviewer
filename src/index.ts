/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { DurableObject } from "cloudflare:workers";
import {
  GitHub, GitHubError, REVIEW_SCHEMA, buildDiffForModel, createAppJwt, formatComment, formatReviewBody,
  parseReview, partitionComments, systemPrompt, userPrompt, verifyGitHubSignature,
  type PRFile, type ReviewComment, type ReviewResult,
} from "./lib";

export interface Env {
  AI: Ai;
  PR_REVIEWER: DurableObjectNamespace<PRReviewer>;

  // Secrets (npx wrangler secret put <NAME>)
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY?: string;

  // Vars (wrangler.jsonc)
  MODEL_PROVIDER: string;      // "anthropic" | "workers-ai"
  ANTHROPIC_MODEL: string;
  WORKERS_AI_MODEL: string;
  CHECK_NAME: string;
  DEBOUNCE_SECONDS: string;
  MAX_DIFF_CHARS: string;
  MAX_INLINE_COMMENTS: string;
  BLOCK_ON_BLOCKERS: string;   // "true" -> check fails when the model reports a blocker
  SKIP_LABEL: string;          // PRs with this label are not reviewed
}

interface Job { owner: string; repo: string; pr: number; sha: string; installationId: number }

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/* ================================================================== */
/* Webhook entry point                                                 */
/* ================================================================== */

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response("pr-reviewer is running");
    if (request.method !== "POST" || url.pathname !== "/webhook") return new Response("Not found", { status: 404 });

    const body = await request.text();
    if (!(await verifyGitHubSignature(body, request.headers.get("x-hub-signature-256"), env.WEBHOOK_SECRET))) {
      return new Response("Invalid signature", { status: 401 });
    }

    const event = request.headers.get("x-github-event") ?? "";
    if (event === "ping") return new Response("pong");

    const job = jobFromEvent(event, JSON.parse(body), env);
    if (!job) return new Response("ignored");

    // One Durable Object per PR: pushes to the same PR are serialised and debounced there.
    const stub = env.PR_REVIEWER.get(env.PR_REVIEWER.idFromName(`${job.owner}/${job.repo}#${job.pr}`));
    await stub.enqueue(job);
    return new Response("queued", { status: 202 });
  },
} satisfies ExportedHandler<Env>;

function jobFromEvent(event: string, p: any, env: Env): Job | null {
  if (event === "pull_request") {
    if (!["opened", "reopened", "synchronize", "ready_for_review"].includes(p.action)) return null;
    const pr = p.pull_request;
    if (pr.draft || pr.state !== "open") return null;
    if (env.SKIP_LABEL && pr.labels?.some((l: any) => l.name === env.SKIP_LABEL)) return null;
    return { owner: p.repository.owner.login, repo: p.repository.name, pr: pr.number, sha: pr.head.sha, installationId: p.installation.id };
  }
  // "Re-run" clicked on our check in the PR's Checks tab
  if (event === "check_run" && p.action === "rerequested" && String(p.check_run.app?.id) === String(env.GITHUB_APP_ID)) {
    const pr = p.check_run.pull_requests?.[0];
    if (!pr) return null;
    return { owner: p.repository.owner.login, repo: p.repository.name, pr: pr.number, sha: p.check_run.head_sha, installationId: p.installation.id };
  }
  return null;
}

/* ================================================================== */
/* Per-PR reviewer (Durable Object)                                    */
/* ================================================================== */

export class PRReviewer extends DurableObject<Env> {
  private token?: { value: string; expiresAt: number };

  /** Called by the Worker for every push. Latest push wins; review starts after a short quiet period. */
  async enqueue(job: Job): Promise<void> {
    await this.ctx.storage.put({ pending: job, latestSha: job.sha });
    await this.ctx.storage.setAlarm(Date.now() + num(this.env.DEBOUNCE_SECONDS, 20) * 1000);
  }

  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    const job = await this.ctx.storage.get<Job>("pending");
    if (!job) return;
    try {
      await this.review(job);
      await this.clearPending(job);
    } catch (err) {
      console.error(`Review of ${job.owner}/${job.repo}#${job.pr} @ ${job.sha} failed`, err);
      if ((info?.retryCount ?? 0) < 2) throw err; // Cloudflare retries alarms with backoff
      await this.clearPending(job);
      await this.finishCheck(job, "failure", "AI review could not run", `\`\`\`\n${String(err).slice(0, 3000)}\n\`\`\`\nClick **Re-run** to try again.`)
        .catch((e) => console.error("Could not mark check as failed", e));
    }
  }

  /* ---------------------------- the review ---------------------------- */

  private async review(job: Job): Promise<void> {
    const gh = await this.github(job.installationId);
    const base = `/repos/${job.owner}/${job.repo}`;
    await this.startCheck(job);

    const pr = await gh.req("GET", `${base}/pulls/${job.pr}`);
    if (pr.state !== "open" || pr.head.sha !== job.sha) {
      return this.finishCheck(job, "neutral", "Skipped", "A newer commit was pushed or the PR was closed.");
    }

    const files = await this.listFiles(gh, base, job.pr);
    const diff = buildDiffForModel(files, num(this.env.MAX_DIFF_CHARS, 120_000));
    if (!diff.text) {
      const tooBig = diff.skipped.some((s) => s.reason !== "ignored");
      return this.finishCheck(job, tooBig ? "neutral" : "success",
        tooBig ? "PR too large for AI review" : "Nothing to review",
        tooBig ? "No reviewable file fit within MAX_DIFF_CHARS." : "Only lockfiles, generated or binary files changed.");
    }

    const guidelines = await this.fetchGuidelines(gh, base, job.sha);
    const { result, model } = await this.callModel(
      systemPrompt(guidelines),
      userPrompt({ title: pr.title, body: pr.body, base: pr.base.ref, head: pr.head.label }, diff.text, diff.skipped),
    );

    // A newer push may have arrived while the model was thinking. Don't post stale feedback.
    if ((await this.ctx.storage.get<string>("latestSha")) !== job.sha) {
      return this.finishCheck(job, "neutral", "Superseded", "A newer commit was pushed during the review.");
    }

    const already = await this.existingBotComments(gh, base, job.pr);
    const { inline, overflow, duplicates } = partitionComments(
      result.comments, diff.commentable, already, num(this.env.MAX_INLINE_COMMENTS, 20),
    );
    await this.postReview(gh, base, job, inline, overflow,
      (extra) => formatReviewBody(result.summary, extra, diff.skipped, duplicates, model));

    const count = (s: string) => result.comments.filter((c) => c.severity === s).length;
    const blockers = count("blocker");
    const failing = blockers > 0 && this.env.BLOCK_ON_BLOCKERS === "true";
    await this.finishCheck(job, failing ? "failure" : "success",
      `${blockers} blocker(s), ${count("warning")} warning(s), ${count("nit")} nit(s)`,
      `${result.summary}\n\nSee the review on the PR's **Conversation** tab for details.`);
  }

  private async postReview(
    gh: GitHub, base: string, job: Job, inline: ReviewComment[], overflow: ReviewComment[],
    makeBody: (listedInBody: ReviewComment[]) => string,
  ) {
    const send = (comments: ReviewComment[], body: string) =>
      gh.req("POST", `${base}/pulls/${job.pr}/reviews`, {
        commit_id: job.sha,
        event: "COMMENT",
        body,
        comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: formatComment(c) })),
      });
    try {
      await send(inline, makeBody(overflow));
    } catch (err) {
      // GitHub rejects the whole review if any inline position is invalid: fall back to listing everything in the body.
      if (!(err instanceof GitHubError) || err.status !== 422 || inline.length === 0) throw err;
      console.warn("Inline comments rejected, posting summary only:", err.message);
      await send([], makeBody([...inline, ...overflow]));
    }
  }

  /* ----------------------------- model call ----------------------------- */

  private async callModel(system: string, user: string): Promise<{ result: ReviewResult; model: string }> {
    const provider = (this.env.MODEL_PROVIDER || "anthropic").toLowerCase();

    if (provider === "anthropic") {
      if (!this.env.ANTHROPIC_API_KEY) throw new Error("MODEL_PROVIDER is anthropic but the ANTHROPIC_API_KEY secret is not set");
      const model = this.env.ANTHROPIC_MODEL;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": this.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 8000,
          system,
          messages: [{ role: "user", content: user }],
          tools: [{ name: "submit_review", description: "Submit the code review.", input_schema: REVIEW_SCHEMA }],
          tool_choice: { type: "tool", name: "submit_review" },
        }),
      });
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const data: any = await res.json();
      const tool = data.content?.find((b: any) => b.type === "tool_use");
      return { result: parseReview(tool?.input ?? data.content?.find((b: any) => b.type === "text")?.text ?? ""), model };
    }

    if (provider === "workers-ai") {
      const model = this.env.WORKERS_AI_MODEL;
      const messages = [
        { role: "system", content: `${system}\n\nRespond with ONLY a JSON object matching this JSON schema:\n${JSON.stringify(REVIEW_SCHEMA)}` },
        { role: "user", content: user },
      ];
      const base = { messages, max_tokens: 4096, chat_template_kwargs: { enable_thinking: false } };
      let out: any;
      try {
        out = await this.env.AI.run(model as any, { ...base, response_format: { type: "json_schema", json_schema: REVIEW_SCHEMA } } as any);
      } catch (err) {
        console.warn("JSON mode not accepted by this model, retrying without it", err);
        out = await this.env.AI.run(model as any, base as any);
      }
      const content = out?.choices?.[0]?.message?.content ?? out?.response ?? out;
      return { result: parseReview(content), model };
    }

    throw new Error(`Unknown MODEL_PROVIDER "${provider}" (use "anthropic" or "workers-ai")`);
  }

  /* --------------------------- GitHub helpers --------------------------- */

  private async github(installationId: number): Promise<GitHub> {
    if (!this.token || this.token.expiresAt - Date.now() < 5 * 60_000) {
      const app = new GitHub(await createAppJwt(this.env.GITHUB_APP_ID, this.env.GITHUB_PRIVATE_KEY));
      const t = await app.req("POST", `/app/installations/${installationId}/access_tokens`);
      this.token = { value: t.token, expiresAt: Date.parse(t.expires_at) };
    }
    return new GitHub(this.token.value);
  }

  private async botLogin(): Promise<string> {
    let slug = await this.ctx.storage.get<string>("appSlug");
    if (!slug) {
      const app = await new GitHub(await createAppJwt(this.env.GITHUB_APP_ID, this.env.GITHUB_PRIVATE_KEY)).req("GET", "/app");
      slug = app.slug as string;
      await this.ctx.storage.put("appSlug", slug);
    }
    return `${slug}[bot]`;
  }

  private async listFiles(gh: GitHub, base: string, pr: number): Promise<PRFile[]> {
    const files: PRFile[] = [];
    for (let page = 1; page <= 30; page++) {
      const batch: PRFile[] = await gh.req("GET", `${base}/pulls/${pr}/files?per_page=100&page=${page}`);
      files.push(...batch);
      if (batch.length < 100) break;
    }
    return files;
  }

  /** Inline comments this bot already left on still-current lines, as "path:line". */
  private async existingBotComments(gh: GitHub, base: string, pr: number): Promise<Set<string>> {
    const login = await this.botLogin();
    const seen = new Set<string>();
    for (let page = 1; page <= 10; page++) {
      const batch: any[] = await gh.req("GET", `${base}/pulls/${pr}/comments?per_page=100&page=${page}`);
      for (const c of batch) if (c.user?.login === login && c.line != null) seen.add(`${c.path}:${c.line}`);
      if (batch.length < 100) break;
    }
    return seen;
  }

  /** Optional repo-specific review rules, read from the PR's head commit. */
  private async fetchGuidelines(gh: GitHub, base: string, sha: string): Promise<string | null> {
    for (const path of [".github/ai-review.md", "REVIEW.md", "CLAUDE.md", "AGENTS.md"]) {
      try {
        const text = await gh.req<string>("GET", `${base}/contents/${path}?ref=${sha}`, undefined, "application/vnd.github.raw+json");
        if (text.trim()) return text.slice(0, 8000);
      } catch (err) {
        if (!(err instanceof GitHubError) || err.status !== 404) throw err;
      }
    }
    return null;
  }

  /* ----------------------------- Check Runs ----------------------------- */

  private async startCheck(job: Job): Promise<void> {
    const existing = await this.ctx.storage.get<{ sha: string; id: number }>("check");
    if (existing?.sha === job.sha) return; // retry of the same commit: reuse its check
    const gh = await this.github(job.installationId);
    const run = await gh.req("POST", `/repos/${job.owner}/${job.repo}/check-runs`, {
      name: this.env.CHECK_NAME || "AI review",
      head_sha: job.sha,
      status: "in_progress",
      started_at: new Date().toISOString(),
    });
    await this.ctx.storage.put("check", { sha: job.sha, id: run.id });
  }

  private async finishCheck(job: Job, conclusion: "success" | "failure" | "neutral", title: string, summary: string): Promise<void> {
    const check = await this.ctx.storage.get<{ sha: string; id: number }>("check");
    if (!check || check.sha !== job.sha) return;
    const gh = await this.github(job.installationId);
    await gh.req("PATCH", `/repos/${job.owner}/${job.repo}/check-runs/${check.id}`, {
      status: "completed",
      conclusion,
      completed_at: new Date().toISOString(),
      output: { title: title.slice(0, 255), summary: summary.slice(0, 60_000) },
    });
  }

  private async clearPending(job: Job): Promise<void> {
    const current = await this.ctx.storage.get<Job>("pending");
    if (current?.sha === job.sha) await this.ctx.storage.delete("pending");
  }
}