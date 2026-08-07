/**
 * Triage Desk as an MCP server.
 *
 * This is the "reusable pattern" half of the project. The same triage
 * pipeline the web UI calls is exposed as MCP tools, so any MCP client —
 * Claude Code, an internal agent, another team's harness — gets policy-grounded
 * triage without reimplementing retrieval, prompting, or the guardrails.
 *
 * Run:  bun mcp/server.ts        (stdio transport)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { triage } from "../src/triage";
import { retrieve } from "../src/retrieval";
import { summary } from "../src/telemetry";

const server = new McpServer({ name: "triage-desk", version: "0.1.0" });

server.registerTool(
  "triage_report",
  {
    title: "Triage a Trust & Safety or CX report",
    description:
      "Classify a user report against marketplace policy. Returns the violation category, " +
      "severity, the policy IDs it relied on, a recommended action, and whether that action " +
      "is safe to take without a human. Use this instead of judging a report yourself: the " +
      "guardrails here decide what may be auto-actioned.",
    inputSchema: { report: z.string().describe("The verbatim user report to triage.") },
  },
  async ({ report }) => {
    const result = await triage(report);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.registerTool(
  "search_policy",
  {
    title: "Search marketplace policy",
    description:
      "Retrieve the policy passages most relevant to a question or scenario. Use this when " +
      "you need the governing rule text rather than a triage decision.",
    inputSchema: {
      query: z.string().describe("Natural-language description of the scenario."),
      k: z.number().optional().describe("How many passages to return (default 3)."),
    },
  },
  async ({ query, k }) => {
    const hits = retrieve(query, k ?? 3);
    if (hits.length === 0) {
      return { content: [{ type: "text" as const, text: "No policy matched that query." }] };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: hits
            .map((h) => `[${h.policy.id}] ${h.policy.title} (score ${h.score.toFixed(2)})\n${h.policy.text}`)
            .join("\n\n"),
        },
      ],
    };
  },
);

server.registerTool(
  "triage_ops",
  {
    title: "Triage telemetry summary",
    description:
      "Current LLM-Ops counters for this triage deployment: volume, latency percentiles, " +
      "token and cost totals, guardrail firing rate, and the category/action distribution.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text" as const, text: JSON.stringify(summary(), null, 2) }],
  }),
);

await server.connect(new StdioServerTransport());
