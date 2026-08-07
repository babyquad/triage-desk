/**
 * Model adapter.
 *
 * Two modes, one interface:
 *   LIVE  - Claude (Anthropic SDK) with structured outputs + prompt caching.
 *   MOCK  - deterministic rules producing the identical schema.
 *
 * MOCK exists so the whole system — server, UI, tests, and the eval harness —
 * runs green with no API key and no spend in CI. It is also the control arm
 * when measuring whether the model is actually beating a keyword baseline.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Retrieved } from "./retrieval";

export const CATEGORIES = [
  "prohibited_item",
  "counterfeit",
  "payment_fraud",
  "off_platform_transaction",
  "shill_bidding",
  "harassment",
  "spam",
  "no_violation",
] as const;

export const ACTIONS = [
  "remove_listing",
  "suspend_seller",
  "warn_seller",
  "end_stream",
  "refund_buyer",
  "rate_limit",
  "no_action",
  "escalate_to_human",
] as const;

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;

export type Category = (typeof CATEGORIES)[number];
export type Action = (typeof ACTIONS)[number];
export type Severity = (typeof SEVERITIES)[number];

export type Verdict = {
  category: Category;
  severity: Severity;
  confidence: number;
  policy_ids: string[];
  recommended_action: Action;
  rationale: string;
  suggested_reply: string;
};

export type ModelResult = {
  verdict: Verdict;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
  model: string;
};

/** JSON Schema handed to the API so the response is guaranteed to parse. */
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: [...CATEGORIES] },
    severity: { type: "string", enum: [...SEVERITIES] },
    confidence: {
      type: "number",
      description: "0.0-1.0. How confident you are in the category and action.",
    },
    policy_ids: {
      type: "array",
      items: { type: "string" },
      description: "IDs of the policies you relied on, e.g. POL-003. Empty if none apply.",
    },
    recommended_action: { type: "string", enum: [...ACTIONS] },
    rationale: { type: "string", description: "Two sentences max, citing the policy." },
    suggested_reply: {
      type: "string",
      description: "Reply to the reporting user. Plain, non-legalistic, no promises about other users' accounts.",
    },
  },
  required: [
    "category",
    "severity",
    "confidence",
    "policy_ids",
    "recommended_action",
    "rationale",
    "suggested_reply",
  ],
  additionalProperties: false,
} as const;

const SYSTEM = `You triage Trust & Safety and CX reports for a live-shopping marketplace.

You will be given a report and the policy excerpts retrieved for it. Decide the
category, severity, and the action an agent should take.

Rules:
- Ground every decision in the retrieved policies and cite their IDs. If none of
  them actually covers the report, return an empty policy_ids array and set
  recommended_action to escalate_to_human.
- Minor safety, credible threats of violence, and payment fraud are never
  auto-actioned. Recommend escalate_to_human for those regardless of confidence.
- A late or missing delivery is not a policy violation on its own.
- confidence is your genuine calibration, not a formality. Below 0.7 the system
  routes to a human, which is the correct outcome when the report is ambiguous.
- suggested_reply speaks to the person who filed the report. Never disclose what
  action was taken against another user's account.`;

function buildClient() {
  // Resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login`
  // profile — nothing hardcoded, nothing read from the request.
  return new Anthropic();
}

export function isLive(): boolean {
  return process.env.TRIAGE_MODE === "live";
}

export const MODEL = process.env.TRIAGE_MODEL ?? "claude-opus-5";

export async function classify(report: string, retrieved: Retrieved[]): Promise<ModelResult> {
  return isLive() ? classifyLive(report, retrieved) : classifyMock(report, retrieved);
}

async function classifyLive(report: string, retrieved: Retrieved[]): Promise<ModelResult> {
  const client = buildClient();

  const policyBlock = retrieved
    .map((r) => `[${r.policy.id}] ${r.policy.title}\n${r.policy.text}`)
    .join("\n\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: [
      // Stable prefix first, cached: the instructions never vary per request.
      { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: VERDICT_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: `Retrieved policies:\n\n${policyBlock}\n\n---\n\nReport:\n${report}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("model_refusal");
  }

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("no_text_block");

  return {
    verdict: JSON.parse(text.text) as Verdict,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
    model: response.model,
  };
}

/** Deterministic baseline. Same schema, no network, no spend. */
function classifyMock(report: string, retrieved: Retrieved[]): ModelResult {
  const t = report.toLowerCase();
  const has = (...words: string[]) => words.some((w) => t.includes(w));

  let category: Category = "no_violation";
  let severity: Severity = "low";
  let action: Action = "no_action";
  let confidence = 0.55;

  if (has("under 18", "underage", "minor", "13 year", "14 year", "15 year", "16 year", "17 year")) {
    category = "harassment";
    severity = "critical";
    action = "escalate_to_human";
    confidence = 0.92;
  } else if (has("kill you", "threat", "threaten", "hurt you", "slur", "racist")) {
    category = "harassment";
    severity = "critical";
    action = "escalate_to_human";
    confidence = 0.88;
  } else if (has("gun", "firearm", "ammo", "ammunition", "pistol", "rifle", "vape", "nicotine")) {
    category = "prohibited_item";
    severity = "high";
    action = "remove_listing";
    confidence = 0.85;
  } else if (has("fake", "counterfeit", "replica", "rep ", "1:1", "bootleg", "not authentic")) {
    category = "counterfeit";
    severity = "medium";
    action = "remove_listing";
    confidence = 0.78;
  } else if (has("zelle", "venmo", "cash app", "cashapp", "paypal friends", "wire transfer", "off platform", "outside the app", "gift card", "crypto")) {
    category = "off_platform_transaction";
    severity = "high";
    action = "warn_seller";
    confidence = 0.82;
  } else if (has("chargeback", "stolen card", "unauthorized charge", "account takeover", "hacked")) {
    category = "payment_fraud";
    severity = "high";
    action = "escalate_to_human";
    confidence = 0.8;
  } else if (
    has("shill", "bidding on their own", "fake bid", "bid manipulation") ||
    (has("bid") && has("never pay", "never paid", "every single one", "only bids"))
  ) {
    category = "shill_bidding";
    severity = "high";
    action = "escalate_to_human";
    confidence = 0.75;
  } else if (has("mystery box", "no odds", "without odds", "odds listed", "raffle", "gambling")) {
    category = "prohibited_item";
    severity = "medium";
    action = "remove_listing";
    confidence = 0.72;
  } else if (has("psa 10", "no slab", "cert number", "no cert", "won't authenticate", "graded")) {
    category = "counterfeit";
    severity = "medium";
    action = "remove_listing";
    confidence = 0.71;
  } else if (has("spam", "bot", "same message over and over", "same promo", "over and over")) {
    category = "spam";
    severity = "low";
    action = "rate_limit";
    confidence = 0.7;
  } else if (has("never arrived", "not received", "no tracking", "late", "hasn't shipped", "still waiting")) {
    category = "no_violation";
    severity = "low";
    action = "refund_buyer";
    confidence = 0.74;
  }

  // Cite only retrieved policies whose category matches the verdict. Citing the
  // top-k blindly produces citations the verdict never relied on — which is the
  // exact ungrounded-citation failure the guardrails are meant to catch, so the
  // baseline must not manufacture it.
  const cited = retrieved
    .filter((r) => r.policy.category === category)
    .map((r) => r.policy.id);

  return {
    verdict: {
      category,
      severity,
      confidence,
      policy_ids: cited,
      recommended_action: action,
      rationale: `Deterministic baseline matched the ${category} pattern against the retrieved policies.`,
      suggested_reply:
        "Thanks for the report. We've reviewed it against our policies and routed it to the right team. We can't share the outcome for another account, but we'll follow up with you if we need anything else.",
    },
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
    model: "mock-baseline",
  };
}
