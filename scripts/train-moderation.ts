import { createReadStream, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { FEATURE_VERSION, LABELS, features, hashFeature, normalizeText, createClassifier, type WeightFile } from "../src/server/moderation/linear";

// JSONL export of Civil Comments (CC0). Only Node built-ins are needed for training.
import { NORMALIZER_VERSION } from "../src/server/moderation/normalize";
import { getSeedMatcher } from "../src/server/moderation/slurs";

const input = process.argv[2], output = process.argv[3] || "models/moderation/linear.json";
if (!input) throw new Error("Usage: npm run train:moderation -- /path/to/civil-comments.jsonl [output.json]");
const dimensions = 32768, epochs = Number(process.env.MODERATION_TRAIN_EPOCHS || 3);
const maxRows = Number(process.env.MODERATION_TRAIN_ROWS || 250000);
if (!Number.isInteger(epochs) || epochs < 1 || epochs > 30 || !Number.isInteger(maxRows) || maxRows < 100) throw new Error("Invalid training budgets");
const weights = new Float32Array(dimensions * LABELS.length), accum = new Float32Array(weights.length);
const biases = new Float64Array(LABELS.length).fill(-3), biasAccum = new Float64Array(LABELS.length).fill(1);
type Example = { text: string } & Record<typeof LABELS[number], number>;
async function* examples() {
  const stream = createReadStream(input, { encoding: "utf8" });
  let pending = "";
  let n = 0;
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let end: number;
      // Split only on LF: literal U+2028/U+2029 are valid inside JSON strings.
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        if (++n > maxRows) return;
        const row = JSON.parse(line) as Example;
        if (typeof row.text !== "string" || LABELS.some(label => !Number.isFinite(row[label]) || row[label] < 0 || row[label] > 1)) throw new Error(`Invalid training row ${n}`);
        yield row;
      }
      if (pending.length > 1048576) throw new Error("Training JSONL row exceeds 1 MiB");
    }
    if (pending.trim()) throw new Error("Training JSONL must end with LF");
  } finally { stream.destroy(); }
}
let trained = 0;
const digest = createHash("sha256");
// Short posts differ from long news comments. Neutral counterfactuals teach that
// an identity alone is not a toxicity signal; no toxic training label is changed.
const identities = ["gay", "Black", "white", "Muslim", "Jewish", "Christian", "atheist", "lesbian", "bisexual", "transgender", "Asian", "Latino", "female", "male", "disabled", "Hindu", "Buddhist"];
const neutralTemplates = ["{}", "I am {}", "My friend is {}", "We welcome {} people", "The {} community belongs here", "I support equal rights for {} people", "I read an article about {} people"];
const neutral = identities.flatMap(identity => neutralTemplates.map(template => ({ text: template.replace("{}", identity), ...Object.fromEntries(LABELS.map(l => [l, 0])) } as Example)));
function fit(row: Example) {
  const indices = features(row.text, dimensions), norm = 1 / Math.sqrt(indices.length || 1);
  for (let l = 0; l < LABELS.length; l++) {
    const offset = l * dimensions;
    let sum = biases[l];
    for (const index of indices) sum += weights[offset + index] * norm;
    const gradient = 1 / (1 + Math.exp(-sum)) - row[LABELS[l]];
    biasAccum[l] += gradient * gradient;
    biases[l] -= 0.3 * gradient / Math.sqrt(biasAccum[l]);
    const g = gradient * norm;
    for (const index of indices) {
      const j = offset + index, regularized = g + 0.000001 * weights[j];
      accum[j] += regularized * regularized;
      weights[j] -= 0.3 * regularized / Math.sqrt(accum[j] + 0.0001);
    }
  }
}
for (let epoch = 0; epoch < epochs; epoch++) {
  let count = 0;
  for await (const row of examples()) {
    const normalized = normalizeText(row.text);
    // Identical normalized text always stays in the same partition.
    if (hashFeature(normalized) % 10 === 0) continue;
    if (epoch === 0) digest.update(JSON.stringify(row) + "\n");
    fit(row);
    if (count % 50 === 0) fit(neutral[(Math.floor(count / 50) + epoch * 31) % neutral.length]);
    count++;
  }
  trained = count;
  console.log(`epoch ${epoch + 1}/${epochs}: ${count} training examples`);
}
const quantized = new Int8Array(weights.length), scales: number[] = [];
for (let l = 0; l < LABELS.length; l++) {
  const offset = l * dimensions;
  let max = 0;
  for (let i = 0; i < dimensions; i++) max = Math.max(max, Math.abs(weights[offset + i]));
  const scale = max / 127 || 1;
  scales.push(scale);
  for (let i = 0; i < dimensions; i++) quantized[offset + i] = Math.round(weights[offset + i] / scale);
}
const dataHash = digest.digest("hex");
const featureHash = createHash("sha256");
for (const name of ["linear", "normalize", "unicode-data", "slurs", "slur-seed"]) featureHash.update(readFileSync(`src/server/moderation/${name}.ts`));
const featureSha256 = featureHash.digest("hex");
const file: WeightFile = {
  format: "elytra-linear-int8-v1", features: FEATURE_VERSION,
  version: `civil-comments-${dataHash.slice(0, 12)}-e${epochs}-d${dimensions}-neutral-v1-${FEATURE_VERSION}-${featureSha256.slice(0, 8)}`,
  dimensions, labels: LABELS, biases: [...biases], scales,
  weights: Buffer.from(quantized.buffer).toString("base64"),
  provenance: { dataset: "google/civil_comments (Jigsaw Unintended Bias)", license: "CC0-1.0",
    source: "https://huggingface.co/datasets/google/civil_comments", trainingSha256: dataHash,
    featureSha256, normalizer: NORMALIZER_VERSION, lexicon: getSeedMatcher().version, trained, maxRows, epochs, optimizer: "AdaGrad, lr=0.3, L2=1e-6, soft annotator labels",
    augmentation: { version: "neutral-v1", examples: neutral.length, frequency: "one neutral short identity counterfactual per 50 training rows" },
    split: "FNV-1a(normalized text) % 10 == 0 is holdout; all other rows train" },
};
const classifier = createClassifier(file, new Uint8Array(quantized.buffer));
const metrics = LABELS.map(() => ({ n: 0, positives: 0, negatives: 0, tp: 0, fp: 0, brier: 0 }));
const identity = { n: 0, flagged: 0 };
for await (const row of examples()) {
  if (hashFeature(normalizeText(row.text)) % 10 !== 0) continue;
  const scores = classifier.score(row.text);
  for (let l = 0; l < LABELS.length; l++) {
    const label = LABELS[l], m = metrics[l], positive = row[label] >= 0.5, flagged = scores[label] >= 0.95;
    m.n++; m.positives += +positive; m.negatives += +!positive;
    m.tp += +(positive && flagged); m.fp += +(!positive && flagged); m.brier += (scores[label] - row[label]) ** 2;
  }
  if (row.toxicity < 0.1 && /\b(gay|black|muslim|jewish|transgender|lesbian)\b/i.test(row.text)) {
    identity.n++; identity.flagged += +(Math.max(...Object.values(scores)) >= 0.95);
  }
}
file.provenance.holdout = Object.fromEntries(LABELS.map((label, l) => [label, { ...metrics[l], brier: metrics[l].brier / Math.max(1, metrics[l].n) }]));
file.provenance.identityMentionProxy = { ...identity, note: "Non-toxic identity mentions, not Jigsaw subgroup AUC; threshold=0.95" };
file.provenance.identityProbes = Object.fromEntries(["I am gay", "I am Black", "My Muslim friends are welcome", "Transgender people deserve respect"].map(text => [text, classifier.score(text)]));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(file) + "\n");
console.log(JSON.stringify({ output, version: file.version, bytes: Buffer.byteLength(JSON.stringify(file)), provenance: file.provenance }, null, 2));
