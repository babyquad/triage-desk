import { describe, expect, test } from "bun:test";
import { retrieve, stem, tokenize } from "../src/retrieval";
import { applyGuardrails, safetyScreen, triage, CONFIDENCE_FLOOR } from "../src/triage";
import type { Verdict } from "../src/llm";

const base: Verdict = {
  category: "counterfeit",
  severity: "medium",
  confidence: 0.9,
  policy_ids: ["POL-002"],
  recommended_action: "remove_listing",
  rationale: "r",
  suggested_reply: "s",
};

describe("retrieval", () => {
  test("drops stopwords and punctuation, lowercases, and stems", () => {
    expect(tokenize("The seller's ZELLE request!")).toEqual(["seller", "zell", "request"]);
  });

  test("stemmer collapses the inflections that caused a real retrieval miss", () => {
    expect(stem("vaping")).toBe(stem("vape"));
    expect(stem("listings")).toBe(stem("listing"));
    expect(stem("boxes")).toBe(stem("box"));
    expect(stem("suspended")).toBe("suspend");
  });

  test("stemmer leaves short tokens and double-s alone", () => {
    expect(stem("bid")).toBe("bid");
    expect(stem("address")).toBe("address");
  });

  test("surfaces the governing policy for an off-platform report", () => {
    const ids = retrieve("seller asked me to pay by zelle outside the app", 3).map((r) => r.policy.id);
    expect(ids).toContain("POL-003");
  });

  test("returns nothing for a query with no signal", () => {
    expect(retrieve("the and of to", 3)).toEqual([]);
  });
});

describe("safety screen", () => {
  test("catches minor-safety language the classifier missed", () => {
    expect(safetyScreen("the streamer said he is in his sophomore year")).toBe("minor_safety");
    expect(safetyScreen("pretty sure this kid is 15 years old")).toBe("minor_safety");
  });

  test("catches threats of violence", () => {
    expect(safetyScreen("he said he would find him at his house and hurt him")).toBe("violence_threat");
  });

  test("catches account compromise", () => {
    expect(safetyScreen("three orders I never made after someone got into my account")).toBe(
      "account_compromise",
    );
  });

  test("stays quiet on an ordinary shipping complaint", () => {
    expect(safetyScreen("my card arrived two days late but it is here")).toBeNull();
  });

  test("overrides the classifier regardless of category or confidence", () => {
    const { guardrail, verdict } = applyGuardrails(
      { ...base, category: "no_violation", severity: "low", confidence: 0.99 },
      3,
      "he mentioned he is 15 and still in high school",
    );
    expect(guardrail).toBe("safety_screen:minor_safety");
    expect(verdict.recommended_action).toBe("escalate_to_human");
  });
});

describe("guardrails", () => {
  test("clean high-confidence verdict passes through", () => {
    const { guardrail, verdict } = applyGuardrails(base, 3);
    expect(guardrail).toBeNull();
    expect(verdict.recommended_action).toBe("remove_listing");
  });

  test("no retrieved policy forces a human", () => {
    const { guardrail, verdict } = applyGuardrails(base, 0);
    expect(guardrail).toBe("no_policy_retrieved");
    expect(verdict.recommended_action).toBe("escalate_to_human");
  });

  test("uncited verdict forces a human even when confident", () => {
    const { guardrail } = applyGuardrails({ ...base, policy_ids: [], confidence: 0.99 }, 3);
    expect(guardrail).toBe("no_policy_cited");
  });

  test("payment fraud is never auto-actioned", () => {
    const { guardrail, verdict } = applyGuardrails(
      { ...base, category: "payment_fraud", confidence: 0.99 },
      3,
    );
    expect(guardrail).toBe("category_requires_human");
    expect(verdict.recommended_action).toBe("escalate_to_human");
  });

  test("critical severity is never auto-actioned", () => {
    expect(applyGuardrails({ ...base, severity: "critical" }, 3).guardrail).toBe("critical_severity");
  });

  test("high-impact action below the confidence floor is held", () => {
    const { guardrail } = applyGuardrails(
      { ...base, confidence: CONFIDENCE_FLOOR - 0.01, recommended_action: "suspend_seller" },
      3,
    );
    expect(guardrail).toBe("low_confidence_high_impact");
  });

  test("low-impact action below the floor still passes", () => {
    const { guardrail } = applyGuardrails(
      { ...base, confidence: CONFIDENCE_FLOOR - 0.01, recommended_action: "no_action" },
      3,
    );
    expect(guardrail).toBeNull();
  });
});

describe("pipeline", () => {
  test("rejects an empty report", () => {
    expect(triage("   ")).rejects.toThrow("empty_report");
  });

  test("returns a cited, gated verdict end to end", async () => {
    const res = await triage("Seller keeps telling buyers to Zelle him directly to skip fees.");
    expect(res.verdict.category).toBe("off_platform_transaction");
    expect(res.policies.length).toBeGreaterThan(0);
    expect(res.verdict.policy_ids.length).toBeGreaterThan(0);
    expect(typeof res.auto_actionable).toBe("boolean");
  });

  test("a minor-safety report always lands on a human", async () => {
    const res = await triage("The streamer mentioned he is 15 and in his sophomore year.");
    expect(res.verdict.recommended_action).toBe("escalate_to_human");
    expect(res.auto_actionable).toBe(false);
  });
});
