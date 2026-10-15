import "server-only";
import { sharedCapacity } from "../concurrency";
import { normalizeText, type Scores } from "./linear";
import { moderationConfig, type ModerationConfig } from "./config";
import { slurSignals, type SlurHit } from "./slurs";

export const GUARD_CATEGORIES = ["Violent", "Non-violent Illegal Acts", "Sexual Content or Sexual Acts", "PII", "Suicide & Self-Harm", "Unethical Acts", "Politically Sensitive Topics", "Copyright Violation", "Jailbreak"] as const;
export type GuardResult = { verdict: "Safe" | "Controversial" | "Unsafe" | "unknown"; categories: string[]; status: string; latencyMs: number };
export function parseGuardOutput(output: string): Pick<GuardResult, "verdict" | "categories" | "status"> {
  const unknown = { verdict: "unknown" as const, categories: [], status: "malformed" };
  const match = /^Safety: (Safe|Controversial|Unsafe)\r?\nCategories: ([^\r\n]+)$/.exec(output.trim());
  if (!match) return unknown;
  const verdict = match[1] as "Safe" | "Controversial" | "Unsafe";
  const categories = match[2].split(",").map(c => c.trim());
  if (verdict === "Safe") return match[2] === "None" ? { verdict, categories: [], status: "ok" } : unknown;
  if (!categories.length || new Set(categories).size !== categories.length ||
      categories.some(c => !(GUARD_CATEGORIES as readonly string[]).includes(c))) return unknown;
  return { verdict, categories, status: "ok" };
}

// Exact single-user branch of Qwen's tokenizer_config.json at fada3b2f655b89601929198343c94cd2f64d93cc.
// Use /completion, avoiding server-specific generic chat template fallbacks.
const PREFIX = `<|im_start|>user
# Task:
1) Evaluate whether THE LAST USER's query belongs to safe or unsafe content based on our safety policy.
2) Identify the category of unsafe content found.

<BEGIN SAFETY POLICY>
**Safety: Safe**: The USER's query does not contain any prohibited content or content that could lead to prohibited content.
**Safety: Unsafe**: The USER's query contains prohibited content.
**Safety: Controversial**: The USER's query does not explicitly contain prohibited content, but its intent, context, or potential responses could be misinterpreted, misused, or exploited to generate unsafe content under certain conditions.
<END SAFETY POLICY>

<BEGIN UNSAFE CONTENT CATEGORIES>
Violent.
Non-violent Illegal Acts.
Sexual Content or Sexual Acts.
PII.
Suicide & Self-Harm.
Unethical Acts.
Politically Sensitive Topics.
Copyright Violation.
Jailbreak.
<END UNSAFE CONTENT CATEGORIES>

<BEGIN CONVERSATION>

USER: `;
const SUFFIX = `

<END CONVERSATION>

Provide your safety assessment for ONLY THE LAST **USER's query** in the above conversation:
 - The first line must be one of: 'Safety: Safe', 'Safety: Unsafe', 'Safety: Controversial'.
 - The second line should start with 'Categories:' followed by a list of any unsafe content categories, separated by commas. If the content is safe, use 'Categories: None'.<|im_end|>
<|im_start|>assistant
<think>

</think>

`;
export function guardPrompt(text: string, hits: readonly SlurHit[] = []): string {
  const normalized = normalizeText(text);
  // Keep the original for meaning; the lossy skeleton and lexical signals are context, not a verdict.
  const obfuscated = hits.some(h => text.slice(h.start, h.end).toLowerCase() !== h.entry.term.toLowerCase());
  const context = obfuscated ? `\n\nNormalized reading: ${normalized}` : "";
  const counts = slurSignals(hits);
  const signals = hits.length ? `\nDictionary context (not a safety verdict): ${JSON.stringify({ high: counts.high, ambiguous: counts.ambiguous })}. Ambiguous matches may describe reclaimed identity, regional slang, or non-hateful meanings. A dictionary match is not evidence of harmful intent; assess the meaning of the original text.` : "";
  return PREFIX + (text + context + signals).replace(/<\|/g, "< |") + SUFFIX;
}
export function shouldEscalate(scores: Scores, config = moderationConfig()): boolean {
  return config.escalation === "all" || (config.escalation === "borderline" &&
    Object.values(scores).some(score => score >= config.low && score <= config.high));
}

type Circuit = { failures: number; openUntil: number; probing: boolean };
const shared = globalThis as typeof globalThis & { elytraGuardCircuits?: Map<string, Circuit> };
export async function classifyGuard(text: string, config: ModerationConfig = moderationConfig(), hits: readonly SlurHit[] = []): Promise<GuardResult> {
  const start = performance.now();
  const unknown = (status: string): GuardResult => ({ verdict: "unknown", categories: [], status, latencyMs: performance.now() - start });
  const circuits = shared.elytraGuardCircuits ??= new Map();
  let circuit = circuits.get(config.guardUrl);
  if (!circuit) { circuit = { failures: 0, openUntil: 0, probing: false }; circuits.set(config.guardUrl, circuit); }
  if (circuit.openUntil > Date.now() || circuit.probing) return unknown("circuit_open");
  try {
    return await sharedCapacity(`moderation-guard:${config.guardUrl}`, 1, config.queue, config.timeoutMs).run(async () => {
      if (circuit.openUntil > Date.now() || circuit.probing) return unknown("circuit_open");
      circuit.probing = circuit.failures >= config.failures;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetch(`${config.guardUrl.replace(/\/$/, "")}/completion`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ prompt: guardPrompt(text, hits), n_predict: 128, temperature: 0, seed: 0,
            cache_prompt: true, stream: false, stop: ["<|im_end|>", "<|endoftext|>"] }),
        });
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("guard_http"); }
        const reader = response.body.getReader();
        let bytes = 0, body = "";
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 8192) { await reader.cancel(); throw new Error("guard_body"); }
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
        const result: unknown = JSON.parse(body);
        if (result && typeof result === "object" && (("stopped_limit" in result && result.stopped_limit === true) ||
            ("truncated" in result && result.truncated === true))) throw new Error("guard_malformed");
        const content = result && typeof result === "object" && "content" in result ? result.content : null;
        const parsed = typeof content === "string" ? parseGuardOutput(content) : parseGuardOutput("");
        if (parsed.status !== "ok") throw new Error("guard_malformed");
        circuit.failures = 0; circuit.openUntil = 0;
        return { ...parsed, latencyMs: performance.now() - start };
      } catch (error) {
        circuit.failures++;
        if (circuit.failures >= config.failures) circuit.openUntil = Date.now() + config.cooldownMs;
        return unknown(controller.signal.aborted ? "timeout" : error instanceof Error && error.message === "guard_malformed" ? "malformed" : "unavailable");
      } finally { clearTimeout(timer); circuit.probing = false; }
    });
  } catch { return unknown("overloaded"); }
}
