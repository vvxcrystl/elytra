# Linear text moderation weights

`linear.json` is a 302 KiB int8 multi-label logistic regression, trained locally
using `scripts/train-moderation.ts`. No comment texts are included. The decoded
weight array is 224 KiB (32,768 buckets × seven labels). Labels, feature version,
training digest, feature-code SHA-256, optimizer, sample counts, holdout metrics, and neutral identity
augmentation are embedded in `provenance`. The weights are released under CC0-1.0.

Training data: [Civil Comments](https://huggingface.co/datasets/google/civil_comments),
the CC0 release of Jigsaw Unintended Bias in Toxicity Classification, first
250,000 rows of shard `default/train/0000.parquet`. The source parquet SHA-256 is
`c20f01c3aecbdd942886cacb0ee67e995df33bc712a622fde75927ed3d6ccefe`.
224,889 rows train; 25,111 are held out using the normalized-text hash partition.
There are 119 generated neutral identity sentences, interleaved once per 50
training rows. Tier 0 high/ambiguous/category feature namespaces are trained
from the same 79-entry seed matcher and Unicode normalizer used in inference.
Probe sentences can overlap those synthetic examples; they are
sanity checks, not independent evidence of fairness.

This is a small English escalation model, not a validated autonomous moderator.
At a 0.95 score threshold, holdout toxicity has 44 true positives out of 1,971
positive examples and 2 false positives out of 23,140 negatives. The conservative
threshold trades substantial recall for precision. All seven labels and the
non-toxic identity-mention proxy (0/163 flagged) are reported in the artifact.
This proxy is small and does not replace the challenge's subgroup/BPSN/BNSP AUC
assessment. No severe-toxicity positives occur at a 0.5 annotation cutoff in this
holdout. Retrain and validate on your community before enabling enforcement.

See [moderation operations](../../docs/MODERATION.md) for reproduction and guard
setup. Guard GGUF files are deliberately not bundled with these weights.
