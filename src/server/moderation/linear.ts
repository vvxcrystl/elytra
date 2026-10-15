// Training and inference share the normalizer, seed matcher, and feature namespaces.
import { normalizeMapped, normalizedReading } from "./normalize";
import { getSeedMatcher, slurSignals, type SlurHit } from "./slurs";
export { normalizeText } from "./normalize";
export const FEATURE_VERSION = "elytra-ngram-v2";
export const LABELS = ["toxicity", "severe_toxicity", "obscene", "threat", "insult", "identity_attack", "sexual_explicit"] as const;
export type Scores = Record<typeof LABELS[number], number>;
export function hashFeature(text: string, seed = 2166136261): number {
  let hash = seed;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}
/** Binary hashed character 2..5 grams and word 1..2 grams, L2 normalized. */
export function features(text: string, dimensions: number, hits?: readonly SlurHit[]): number[] {
  const prepared = normalizeMapped(text, true);
  const signals = slurSignals(hits ?? getSeedMatcher().match(text, false, prepared));
  const normalized = normalizedReading(prepared), indices = new Set<number>(), mask = dimensions - 1;
  const chars = ` ${normalized} `;
  for (let i = 0; i < chars.length - 1; i++) {
    let hash = 0x811c9dc5 ^ 99; // character namespace
    for (let n = 0; n < 5 && i + n < chars.length; n++) {
      hash = Math.imul(hash ^ chars.charCodeAt(i + n), 16777619);
      if (n >= 1) indices.add((hash >>> 0) & mask);
    }
  }
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  for (let i = 0; i < words.length; i++) {
    indices.add(hashFeature(`w:${words[i]}`) & mask);
    if (i) indices.add(hashFeature(`b:${words[i - 1]} ${words[i]}`) & mask);
  }
  if (signals.high) indices.add(hashFeature("slur:high") & mask);
  if (signals.ambiguous) indices.add(hashFeature("slur:ambiguous") & mask);
  for (const category of signals.categories) indices.add(hashFeature(`slur:category:${category}`) & mask);
  return [...indices];
}
export type WeightFile = {
  format: "elytra-linear-int8-v1"; features: typeof FEATURE_VERSION; version: string;
  dimensions: number; labels: readonly string[]; biases: number[]; scales: number[]; weights: string;
  provenance: Record<string, unknown>;
};
export type Classifier = { version: string; score: (text: string, hits?: readonly SlurHit[]) => Scores };
export function createClassifier(file: WeightFile, bytes: Uint8Array): Classifier {
  if (file.format !== "elytra-linear-int8-v1" || file.features !== FEATURE_VERSION ||
      file.labels.join() !== LABELS.join() || !Number.isInteger(file.dimensions) || file.dimensions < 1024 ||
      file.dimensions > 1048576 || (file.dimensions & (file.dimensions - 1)) !== 0 ||
      bytes.length !== file.dimensions * LABELS.length || file.biases.length !== LABELS.length ||
      file.scales.length !== LABELS.length || !file.biases.every(Number.isFinite) ||
      !file.scales.every(s => Number.isFinite(s) && s > 0) || !file.version) throw new Error("Invalid moderation weights");
  const weights = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { version: file.version, score(text, hits) {
    const indices = features(text, file.dimensions, hits), norm = 1 / Math.sqrt(indices.length || 1);
    const scores = {} as Scores;
    for (let label = 0; label < LABELS.length; label++) {
      let sum = 0;
      const offset = label * file.dimensions;
      for (let i = 0; i < indices.length; i++) sum += weights[offset + indices[i]];
      scores[LABELS[label]] = 1 / (1 + Math.exp(-(file.biases[label] + sum * norm * file.scales[label])));
    }
    return scores;
  } };
}
