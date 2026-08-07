/**
 * LLM-Ops telemetry: latency, tokens, cost, guardrail firings.
 *
 * Kept in-process with a JSONL sink so the prototype has no infra dependency.
 * The shape is what a real deployment forwards to its metrics backend.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

const SINK = process.env.TRIAGE_TELEMETRY ?? "./telemetry.jsonl";

// Claude Opus 5 list price, USD per million tokens.
const USD_PER_MTOK_IN = 5;
const USD_PER_MTOK_OUT = 25;
const CACHE_READ_MULTIPLIER = 0.1;

export type Record_ = {
  ts: string;
  model: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  category: string;
  action: string;
  confidence: number;
  guardrail: string | null;
  ok: boolean;
};

export function estimateCost(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}): number {
  const billedIn = Math.max(0, u.input_tokens);
  const cached = Math.max(0, u.cache_read_input_tokens);
  return (
    (billedIn / 1e6) * USD_PER_MTOK_IN +
    (cached / 1e6) * USD_PER_MTOK_IN * CACHE_READ_MULTIPLIER +
    (u.output_tokens / 1e6) * USD_PER_MTOK_OUT
  );
}

const buffer: Record_[] = [];

export function record(r: Record_): void {
  buffer.push(r);
  try {
    appendFileSync(SINK, JSON.stringify(r) + "\n");
  } catch {
    // Telemetry must never take the request path down.
  }
}

function load(): Record_[] {
  if (buffer.length > 0) return buffer;
  if (!existsSync(SINK)) return [];
  return readFileSync(SINK, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record_];
      } catch {
        return [];
      }
    });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i]!;
}

export function summary() {
  const rows = load();
  const lat = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
  const byCategory: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  let guardrailed = 0;

  for (const r of rows) {
    byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    byAction[r.action] = (byAction[r.action] ?? 0) + 1;
    if (r.guardrail) guardrailed++;
  }

  return {
    requests: rows.length,
    errors: rows.filter((r) => !r.ok).length,
    guardrail_firings: guardrailed,
    guardrail_rate: rows.length ? +(guardrailed / rows.length).toFixed(3) : 0,
    latency_ms: {
      p50: percentile(lat, 50),
      p95: percentile(lat, 95),
      max: lat.at(-1) ?? 0,
    },
    tokens: {
      input: rows.reduce((s, r) => s + r.input_tokens, 0),
      output: rows.reduce((s, r) => s + r.output_tokens, 0),
      cache_read: rows.reduce((s, r) => s + r.cache_read_input_tokens, 0),
    },
    cost_usd: +rows.reduce((s, r) => s + r.cost_usd, 0).toFixed(6),
    by_category: byCategory,
    by_action: byAction,
  };
}
