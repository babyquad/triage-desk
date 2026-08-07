/**
 * Eval + regression harness.
 *
 *   bun run evals/run.ts            grade the current pipeline
 *   bun run evals/run.ts --json     machine-readable, for CI
 *
 * Three graded dimensions, because "accuracy" alone hides the failure that
 * actually matters here:
 *
 *   category      did it pick the right violation class
 *   retrieval     was the governing policy in the retrieved set (RAG recall)
 *   escalation    did anything that must reach a human actually reach one
 *
 * Escalation recall gates the build at 1.00. A run that classifies well but
 * lets one minor-safety report auto-resolve is a failing run.
 */

import { triage } from "../src/triage";
import { retrieve } from "../src/retrieval";
import { isLive } from "../src/llm";
import golden from "./golden.json";

type Case = {
  id: string;
  report: string;
  expect: { category: string; policy_id: string; must_escalate: boolean };
};

/**
 * Category accuracy is graded against the arm being run: the keyword baseline
 * is not held to the model's bar, and the model is expected to clear the
 * baseline by a wide margin. Retrieval and escalation are properties of the
 * pipeline, not the classifier, so their bars are the same in both modes.
 */
const MODE = isLive() ? "live" : "mock";
const THRESHOLDS = {
  category: Number(process.env.EVAL_MIN_CATEGORY ?? (MODE === "live" ? 0.85 : 0.7)),
  retrieval: Number(process.env.EVAL_MIN_RETRIEVAL ?? 0.85),
  escalation: 1.0, // non-negotiable: safety-critical reports must reach a human
};

const jsonOut = process.argv.includes("--json");

const rows: {
  id: string;
  category_ok: boolean;
  retrieval_ok: boolean;
  escalation_ok: boolean;
  got: string;
  want: string;
  action: string;
  latency_ms: number;
}[] = [];

for (const c of golden as Case[]) {
  const retrieved = retrieve(c.report, 3).map((r) => r.policy.id);
  const res = await triage(c.report);

  const escalated = res.verdict.recommended_action === "escalate_to_human";

  rows.push({
    id: c.id,
    category_ok: res.verdict.category === c.expect.category,
    retrieval_ok: retrieved.includes(c.expect.policy_id),
    escalation_ok: c.expect.must_escalate ? escalated : true,
    got: res.verdict.category,
    want: c.expect.category,
    action: res.verdict.recommended_action,
    latency_ms: res.latency_ms,
  });
}

const rate = (k: "category_ok" | "retrieval_ok" | "escalation_ok") =>
  +(rows.filter((r) => r[k]).length / rows.length).toFixed(3);

const scores = {
  n: rows.length,
  category: rate("category_ok"),
  retrieval: rate("retrieval_ok"),
  escalation: rate("escalation_ok"),
  p95_latency_ms: rows.map((r) => r.latency_ms).sort((a, b) => a - b)[
    Math.floor(0.95 * rows.length)
  ] ?? 0,
};

const failures = (
  Object.keys(THRESHOLDS) as (keyof typeof THRESHOLDS)[]
).filter((k) => scores[k] < THRESHOLDS[k]);

if (jsonOut) {
  console.log(JSON.stringify({ scores, thresholds: THRESHOLDS, failures, rows }, null, 2));
} else {
  console.log(`\n  Triage Desk — eval  (arm: ${MODE})\n`);
  for (const r of rows) {
    const mark = (ok: boolean) => (ok ? "PASS" : "FAIL");
    const line = `  ${r.id}  cat:${mark(r.category_ok)}  ret:${mark(r.retrieval_ok)}  esc:${mark(r.escalation_ok)}  ${r.action}`;
    console.log(r.category_ok && r.retrieval_ok && r.escalation_ok ? line : line + `   (got ${r.got}, want ${r.want})`);
  }
  console.log("\n  " + "-".repeat(56));
  console.log(`  cases            ${scores.n}`);
  console.log(`  category         ${scores.category}  (min ${THRESHOLDS.category})`);
  console.log(`  retrieval@3      ${scores.retrieval}  (min ${THRESHOLDS.retrieval})`);
  console.log(`  escalation       ${scores.escalation}  (min ${THRESHOLDS.escalation})`);
  console.log(`  p95 latency      ${scores.p95_latency_ms} ms`);
  console.log("  " + "-".repeat(56));
  console.log(failures.length === 0 ? "\n  RESULT: pass\n" : `\n  RESULT: fail (${failures.join(", ")})\n`);
}

process.exit(failures.length === 0 ? 0 : 1);
