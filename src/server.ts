/**
 * Triage Desk HTTP surface.
 *
 *   GET  /            operator UI
 *   POST /api/triage  { report } -> verdict + cited policies + guardrail
 *   GET  /api/ops     LLM-Ops telemetry summary
 *   GET  /healthz     liveness
 */

import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { triage } from "./triage";
import { summary } from "./telemetry";
import { isLive, MODEL } from "./llm";

const app = new Hono();

const UI = readFileSync(join(import.meta.dir, "..", "public", "index.html"), "utf8");

app.get("/", (c) => c.html(UI));

app.get("/healthz", (c) =>
  c.json({ ok: true, mode: isLive() ? "live" : "mock", model: isLive() ? MODEL : "mock-baseline" }),
);

app.post("/api/triage", async (c) => {
  let body: { report?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const report = typeof body.report === "string" ? body.report : "";
  if (!report.trim()) return c.json({ error: "report_required" }, 400);
  if (report.length > 8000) return c.json({ error: "report_too_long" }, 413);

  try {
    return c.json(await triage(report));
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    // Fail closed: a broken model path becomes a human handoff, not a silent pass.
    return c.json({ error: message, fallback_action: "escalate_to_human" }, 502);
  }
});

app.get("/api/ops", (c) => c.json(summary()));

const port = Number(process.env.PORT ?? 3020);
console.log(`Triage Desk on :${port}  (mode=${isLive() ? "live" : "mock"})`);

export default { port, fetch: app.fetch };
