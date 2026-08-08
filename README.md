# Triage Desk

An internal Trust & Safety / CX triage tool for a live-shopping marketplace. A
report comes in; the system retrieves the governing policy, classifies the
report against it, and decides whether the recommended action is safe to take
without a human.

Built as a work sample for Whatnot's AI Engineer role. It is small on purpose —
the interesting part is not the classifier, it's everything wrapped around the
classifier that makes an off-the-shelf model dependable enough to sit in front
of an ops queue.

```
report ──▶ retrieve (BM25 over policy corpus)
             │
             ▼
        classify (Claude, structured output + prompt caching)
             │
             ▼
        guardrails ──▶ verdict + cited policy + auto-actionable?
             │
             ▼
        telemetry (latency / tokens / cost / guardrail rate)
```

## Run it

```bash
bun install
bun start          # http://localhost:3020
bun test           # 20 unit tests
bun evals/run.ts   # eval + regression gate
bun mcp/server.ts  # same pipeline over MCP (stdio)
```

Runs with **no API key** by default: `TRIAGE_MODE=mock` uses a deterministic
keyword baseline that produces the identical schema. Set `TRIAGE_MODE=live`
(plus `ANTHROPIC_API_KEY`, or an `ant auth login` profile) to route
classification through Claude.

The mock arm is not a stub — it's the control. It keeps CI free and flake-free,
and it's the baseline the model has to beat before "use an LLM here" is a
justified decision.

## What's actually in here

**Retrieval (`src/retrieval.ts`)** — BM25 over the policy corpus, written
directly so there's no index to stand up. Swap it for pgvector or embeddings
and nothing above it changes.

**Classification (`src/llm.ts`)** — Claude with a JSON Schema via
`output_config.format`, so the response is guaranteed to parse; no
regex-extraction or retry-on-parse loop. The system prompt is a stable prefix
carrying `cache_control`, so repeat traffic reads the cache instead of
re-billing the instructions.

**Guardrails (`src/triage.ts`)** — the model proposes; these rules decide what
may happen without a human:

| Rule | Fires when |
|---|---|
| `safety_screen:*` | Deterministic patterns for minor safety, threats, account compromise, self-harm — checked on the raw report, *before* the classifier's opinion |
| `no_policy_retrieved` | Retrieval came back empty |
| `no_policy_cited` | The model cited no policy — an ungrounded verdict is not actionable |
| `category_requires_human` | Payment fraud, harassment |
| `critical_severity` | Any critical-severity verdict |
| `low_confidence_high_impact` | Confidence below the floor on a suspend/remove/end-stream action |

**Evals (`evals/`)** — 14 labeled reports, graded on three axes: category
accuracy, retrieval recall@3, and escalation recall. Escalation is gated at
**1.00** and cannot be tuned down: a run that classifies well but lets one
minor-safety report auto-resolve is a failing run. Category accuracy is graded
against the arm being run, because holding a keyword baseline to the model's
bar isn't a meaningful test.

**Telemetry (`src/telemetry.ts`)** — p50/p95 latency, token counts (including
cache reads), cost at list price, guardrail firing rate, and the
category/action distribution. Exposed at `/api/ops` and as an MCP tool.

**MCP server (`mcp/server.ts`)** — `triage_report`, `search_policy`, and
`triage_ops`. Any MCP client gets policy-grounded triage without
reimplementing retrieval, prompting, or the guardrails. This is the reusable
half: the web UI and an agent call the same pipeline.

## Three bugs found while building this

The first two surfaced on the first eval run, before any of this had been near
a real report. The third never showed up in a metric at all — every number was
green — and was only visible in the rendered output. They're written up rather
than quietly fixed because they're the argument for having the harness at all.

**1. A retrieval miss from missing stemming.** A report about "vape pens"
never matched the policy line about "vaping products" — different tokens, zero
BM25 overlap, governing policy silently absent from the context. Fixed with
conservative suffix stripping (`src/retrieval.ts`), covered by a test.

**2. Escalation depended on the classifier being right.** A report about a
15-year-old streamer was classified `no_violation`, so no category guardrail
fired and it would have auto-resolved. Category-based rules can't be the only
path to a human when the classifier is the thing that failed. Fixed with the
deterministic safety screen, which runs on the raw report and overrides the
verdict regardless of category or confidence.

The second one is the reason escalation recall is a separate graded axis
instead of being folded into accuracy.

**3. Citations that the verdict never relied on.** Visible only in the UI, not
in any metric: the classifier was citing the top-2 retrieved policies rather
than the ones matching its own verdict, so a report about Zelle payments came
back tagged `off_platform_transaction` while citing the *harassment* policy.
Every number in the eval was green. Fixed by citing only retrieved policies
whose category matches the verdict.

That one is worth its own note: an ungrounded citation is the failure the
`no_policy_cited` guardrail exists to catch, and the system was manufacturing
it internally. Rendering the intermediate state — what was retrieved, in what
order, versus what was cited — is what surfaced it. The `RETRIEVED` line in the
UI still shows the harassment policy out-ranking the correct one on that query,
which is honest: BM25 precision on a 10-document corpus is mediocre, recall@3
is what the pipeline actually depends on, and that's the metric the eval grades.

## Notes on what I did not do

- No fine-tuning or model training — off-the-shelf model, engineering around it.
- No vector DB. At 10 policies BM25 wins on latency and operability; the
  interface is the part worth getting right.
- The policy corpus is written for this prototype. It's realistic in shape
  (indicator lists, severity tiers, escalation carve-outs) but it isn't
  anyone's real policy.

---

Neal Rodriguez · notifyneal@gmail.com · port.ragflo.com
