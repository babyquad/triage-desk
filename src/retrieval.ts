/**
 * Retrieval layer (RAG).
 *
 * BM25 over the policy corpus, implemented directly so the prototype has no
 * external index and no embedding-API dependency. The interface is what
 * matters: swap this for pgvector/Turbopuffer/embeddings and the triage
 * pipeline above it does not change.
 */

import { POLICIES, type Policy } from "./policies";

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "was", "were", "be", "been", "it", "this", "that", "with", "as", "at", "by",
  "from", "has", "have", "had", "i", "my", "me", "he", "she", "they", "them",
  "but", "not", "so", "if", "then", "than", "there", "their", "we", "you",
]);

/**
 * Conservative suffix stripping.
 *
 * Without this, "vape" in a report never matches "vaping" in policy and the
 * governing rule is silently missed — the eval harness caught exactly that.
 * Deliberately shallow: over-stemming collapses distinct terms and costs more
 * precision than the recall is worth on a corpus this size.
 */
export function stem(token: string): string {
  let t = token;
  if (t.length > 4 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  if (t.length > 4) {
    for (const suffix of ["ing", "ed"]) {
      if (t.endsWith(suffix) && t.length - suffix.length >= 3) {
        t = t.slice(0, -suffix.length);
        break;
      }
    }
  }
  // Drop a trailing 'e' so "vape" and "vaping" land on the same stem.
  if (t.length > 3 && t.endsWith("e")) t = t.slice(0, -1);
  return t;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

type Indexed = { policy: Policy; terms: string[]; tf: Map<string, number>; len: number };

const K1 = 1.5;
const B = 0.75;

function buildIndex(policies: Policy[]) {
  const docs: Indexed[] = policies.map((policy) => {
    const terms = tokenize(`${policy.title} ${policy.text}`);
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { policy, terms, tf, len: terms.length };
  });

  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d.terms)) df.set(t, (df.get(t) ?? 0) + 1);

  const avgLen = docs.reduce((s, d) => s + d.len, 0) / docs.length;
  return { docs, df, avgLen, n: docs.length };
}

const INDEX = buildIndex(POLICIES);

export type Retrieved = { policy: Policy; score: number };

/** Return the top-k policies most relevant to `query`, best first. */
export function retrieve(query: string, k = 3): Retrieved[] {
  const qTerms = tokenize(query);
  if (qTerms.length === 0) return [];

  const scored = INDEX.docs.map(({ policy, tf, len }) => {
    let score = 0;
    for (const term of qTerms) {
      const f = tf.get(term);
      if (!f) continue;
      const n = INDEX.df.get(term) ?? 0;
      // BM25 idf with the +1 smoothing that keeps it non-negative.
      const idf = Math.log(1 + (INDEX.n - n + 0.5) / (n + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / INDEX.avgLen)));
    }
    return { policy, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
