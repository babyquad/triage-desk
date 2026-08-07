/**
 * The triage pipeline: retrieve -> classify -> enforce guardrails -> record.
 *
 * The guardrail pass is the part that makes an off-the-shelf model dependable
 * enough to sit in front of an ops queue. The model proposes; these rules
 * decide what is allowed to happen without a human.
 */

import { retrieve } from "./retrieval";
import { classify, MODEL, isLive, type Verdict } from "./llm";
import { estimateCost, record } from "./telemetry";

export const CONFIDENCE_FLOOR = Number(process.env.TRIAGE_CONFIDENCE_FLOOR ?? 0.7);

/** Categories that a human must always confirm, however confident the model is. */
const NEVER_AUTO_ACTION = new Set(["payment_fraud", "harassment"]);

/**
 * Deterministic safety screen, run on the raw report *before* the classifier's
 * opinion is considered.
 *
 * The eval harness caught the failure this exists for: a report about a
 * 15-year-old streamer was classified `no_violation`, so no category-based
 * guardrail fired and it would have auto-resolved. Escalation for the
 * highest-harm categories must not depend on the classifier being right.
 * High recall is the goal here — a false escalation costs an agent a minute,
 * a missed one is a child-safety incident.
 */
const SAFETY_PATTERNS: { name: string; re: RegExp }[] = [
  {
    name: "minor_safety",
    re: /\b(under ?age|underage|under 18|minor|\b1[0-7] ?(?:years? ?old|yo)\b|sophomore|freshman|middle school|high ?school|my mom|his mom|her mom)\b/i,
  },
  {
    name: "violence_threat",
    re: /\b(kill|shoot|stab|beat (?:you|him|her|them) up|hurt (?:you|him|her|them)|find (?:you|him|her|them) at|come to your house|threat(?:en(?:ed|ing)?)?)\b/i,
  },
  {
    name: "account_compromise",
    re: /\b(hacked|account takeover|got into my account|didn'?t (?:make|place) (?:this|these|that|those)|never made (?:this|these|those)? ?order|unauthori[sz]ed (?:charge|order|purchase)|stolen card|chargeback)\b/i,
  },
  {
    name: "self_harm",
    re: /\b(suicide|kill myself|self ?harm|end my life)\b/i,
  },
];

export function safetyScreen(report: string): string | null {
  for (const { name, re } of SAFETY_PATTERNS) {
    if (re.test(report)) return name;
  }
  return null;
}

/** Actions with real user impact — held to the confidence floor. */
const HIGH_IMPACT = new Set(["suspend_seller", "end_stream", "remove_listing"]);

export type TriageResult = {
  verdict: Verdict;
  policies: { id: string; title: string; score: number }[];
  guardrail: string | null;
  auto_actionable: boolean;
  latency_ms: number;
  model: string;
  mode: "live" | "mock";
  cost_usd: number;
};

export async function triage(report: string): Promise<TriageResult> {
  const started = Date.now();
  const trimmed = report.trim();
  if (!trimmed) throw new Error("empty_report");

  const retrieved = retrieve(trimmed, 3);

  let result;
  try {
    result = await classify(trimmed, retrieved);
  } catch (err) {
    const latency = Date.now() - started;
    record({
      ts: new Date().toISOString(),
      model: MODEL,
      latency_ms: latency,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cost_usd: 0,
      category: "unknown",
      action: "escalate_to_human",
      confidence: 0,
      guardrail: "model_error",
      ok: false,
    });
    throw err;
  }

  const { verdict, guardrail } = applyGuardrails(result.verdict, retrieved.length, trimmed);
  const latency_ms = Date.now() - started;
  const cost_usd = estimateCost(result.usage);

  record({
    ts: new Date().toISOString(),
    model: result.model,
    latency_ms,
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    cache_read_input_tokens: result.usage.cache_read_input_tokens,
    cost_usd,
    category: verdict.category,
    action: verdict.recommended_action,
    confidence: verdict.confidence,
    guardrail,
    ok: true,
  });

  return {
    verdict,
    policies: retrieved.map((r) => ({
      id: r.policy.id,
      title: r.policy.title,
      score: +r.score.toFixed(3),
    })),
    guardrail,
    auto_actionable: guardrail === null && verdict.recommended_action !== "escalate_to_human",
    latency_ms,
    model: result.model,
    mode: isLive() ? "live" : "mock",
    cost_usd: +cost_usd.toFixed(6),
  };
}

/**
 * Downgrade an unsafe verdict to a human handoff and say why.
 * Order matters: the first rule that fires is the one reported.
 */
export function applyGuardrails(
  verdict: Verdict,
  retrievedCount: number,
  rawReport = "",
): { verdict: Verdict; guardrail: string | null } {
  const escalate = (reason: string) => ({
    verdict: { ...verdict, recommended_action: "escalate_to_human" as const },
    guardrail: reason,
  });

  // Runs first and ignores the classifier entirely — see SAFETY_PATTERNS.
  const flagged = safetyScreen(rawReport);
  if (flagged) return escalate(`safety_screen:${flagged}`);

  if (retrievedCount === 0) return escalate("no_policy_retrieved");
  if (verdict.policy_ids.length === 0) return escalate("no_policy_cited");
  if (NEVER_AUTO_ACTION.has(verdict.category)) return escalate("category_requires_human");
  if (verdict.severity === "critical") return escalate("critical_severity");
  if (
    HIGH_IMPACT.has(verdict.recommended_action) &&
    verdict.confidence < CONFIDENCE_FLOOR
  ) {
    return escalate("low_confidence_high_impact");
  }

  return { verdict, guardrail: null };
}
