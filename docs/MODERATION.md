# Optional text moderation

Moderation is off unless `ELYTRA_MODERATION=true`. `npm run dev` and ordinary
hosting still need no model server. When enabled, every new post, reply, quote,
registration username/display name/bio, and changed display name/bio is queued in SQLite.
DM ciphertext and images never enter moderation. Existing content is not
backfilled automatically. Reposts reference the original post rather than
creating text to score.

The default is **shadow mode**: record lexical hits, scores, and review recommendations
without changing post visibility. A local slur matcher runs first, then the small
English linear classifier; Qwen3Guard optionally classifies escalated text. The
explicit exception is name validation: when moderation is on, high-severity name
hits are rejected even in shadow mode. Ambiguous/reclaimed names remain allowed.
In the default asynchronous mode, model loading, networking, or parse failures
never reject a post. The optional blocking publication mode below waits for a
valid assessment before sending.

## Check before publishing

To prevent unsafe posts from being published, enable:

```dotenv
ELYTRA_MODERATION=true
ELYTRA_MODERATION_PUBLISH=block
```

Run the guard sidecar first. Every post, reply, and quote then waits for Qwen's
assessment before insertion, regardless of the background escalation setting.
`Unsafe` returns `This content isn't allowed` to the composer (REST error
`moderated_text`, HTTP 400). The draft and attachments remain available to edit.
`Safe` and `Controversial` can publish; ambiguity alone does not reject content.
Accepted posts reuse the assessment for all three audit tiers rather than
invoking the guard again in the background. Rejected candidates are audited
without creating posts, hashtags, mentions, media claims, or notifications.

In this explicitly selected mode, unavailable, overloaded, timed-out, or
malformed guard results keep the draft unpublished and return a retry message
(`moderation_unavailable`, HTTP 503). They are recorded as `unknown`, never as
unsafe. Reading the app continues to work. This differs from the default
`ELYTRA_MODERATION_PUBLISH=off`, which keeps publishing asynchronous and falls
back to tier 1 when the guard is unavailable. No existing posts are deleted.

## Quick start

The trained linear weights are included; tier 1 requires no downloads or new
runtime packages:

```sh
ELYTRA_MODERATION=true ELYTRA_MODERATION_ESCALATION=off npm run dev
```

To add the guard tier, put a Q8_0 guard model at
`data/moderation-models/qwen3guard-q8_0.gguf` (instructions below), then:

```sh
# Reads ELYTRA_GUARD_BACKEND from the environment or .env (default cpu).
# Starts only the selected guard container, without app/tunnel dependencies.
npm run guard:up
ELYTRA_MODERATION=true npm run dev
```

Next loads `.env` itself. For hosting, set `ELYTRA_MODERATION=true` and
`ELYTRA_GUARD_BACKEND=cpu|cuda|rocm|vulkan` in `.env`, then use the optional overlay:

```sh
# Pick ONE profile matching ELYTRA_GUARD_BACKEND:
docker compose -f compose.yaml -f compose.moderation.yaml --profile moderation-cpu up -d --build
# Other alternatives:
# --profile moderation-cuda
# --profile moderation-rocm
# --profile moderation-vulkan
```

The overlay passes moderation settings to the app and uses `http://guard:8081`
on the private Compose network. The host port binds only to `127.0.0.1:8081`.
The base `compose.yaml` stays service-free for moderation. App startup never
waits for guard health. Do not activate multiple guard profiles on the same port.
When switching backends, stop the previous guard service first.

## Guard model and exact protocol

[Qwen's model card](https://huggingface.co/Qwen/Qwen3Guard-Gen-0.6B) describes
user-input safety classification. Elytra treats published text as a single user
message, rather than inventing an assistant conversation. The model is licensed
Apache-2.0; the copied prompt template's license is retained in
[licenses/Qwen3Guard-LICENSE.txt](../licenses/Qwen3Guard-LICENSE.txt).

The exact single-user template from
[`tokenizer_config.json`, revision fada3b2f655b89601929198343c94cd2f64d93cc](https://huggingface.co/Qwen/Qwen3Guard-Gen-0.6B/blob/fada3b2f655b89601929198343c94cd2f64d93cc/tokenizer_config.json)
is implemented in `guard.ts`, including the policy, ChatML markers, conversation
wrapper, and empty thinking prefix. A regression test fingerprints the rendered
prompt. The `/completion` endpoint receives this complete prompt, deterministic
sampling, at most 128 generated tokens, and `cache_prompt: true`. A single server
slot preserves the fixed prefix; only the changing text and suffix need new
prompt evaluation. This avoids reliance on a generic server chat template.

The parser accepts exactly two lines: a safety verdict (`Safe`, `Controversial`,
or `Unsafe`) followed by categories. Safe must have `None`; the other verdicts
must list known, unique categories: Violent, Non-violent Illegal Acts, Sexual
Content or Sexual Acts, PII, Suicide & Self-Harm, Unethical Acts, Politically
Sensitive Topics, Copyright Violation, or Jailbreak. Extra lines, unknown
categories, contradictions, duplicates, truncation, or malformed responses become
`unknown`. That verdict never triggers enforcement. The model's categories are
broader than a social app's policy; political sensitivity or sexuality alone is
not grounds for an Elytra action.

All tiers share the Unicode normalizer described below. The guard receives the
original text to preserve meaning, with a normalized reading for detected evasions.
Lexical counts are additional context, explicitly not a safety verdict; ambiguous
matches may be reclaimed identity or regional language. Category names are not
injected as model accusations. The fixed upstream policy/chat wrapper is unchanged.

### GGUF acquisition or conversion

Qwen's official repository has safetensors, not a GGUF, at the revision above.
The reproducible first-party route is conversion with
[llama.cpp](https://github.com/ggml-org/llama.cpp):

```sh
# Outside the Elytra repository; Python dependencies are conversion-only.
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
# This is the source revision used for the CPU verification below.
git checkout e467e5b5e5ba43071d6151b3d881deb9300d000e
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements/requirements-convert_hf_to_gguf.txt huggingface_hub
hf download Qwen/Qwen3Guard-Gen-0.6B --revision fada3b2f655b89601929198343c94cd2f64d93cc --local-dir ./qwen3guard-hf
python convert_hf_to_gguf.py ./qwen3guard-hf --outfile ./qwen3guard-f16.gguf --outtype f16
cmake -S . -B build -DGGML_NATIVE=OFF -DGGML_AVX2=ON -DGGML_AVX512=OFF -DLLAMA_BUILD_TESTS=OFF
cmake --build build --target llama-quantize llama-server -j 4
build/bin/llama-quantize ./qwen3guard-f16.gguf ./qwen3guard-q8_0.gguf Q8_0
# Copy this file into Elytra's data/moderation-models directory.
```

An optional community conversion was used for the local smoke test, from
[QuantFactory](https://huggingface.co/QuantFactory/Qwen3Guard-Gen-0.6B-GGUF), pinned
to a revision and verified against its published LFS SHA-256:

```sh
mkdir -p data/moderation-models
curl -fL https://huggingface.co/QuantFactory/Qwen3Guard-Gen-0.6B-GGUF/resolve/be4e562404e1bd6d6e01bed9c5fcf1ddb4a6c6aa/Qwen3Guard-Gen-0.6B.Q8_0.gguf -o data/moderation-models/qwen3guard-q8_0.gguf
printf '%s  %s\n' a5108bc29824fbe805d4674cf8af438bb7221186c2fa940175a8dfdda4a8d2cc data/moderation-models/qwen3guard-q8_0.gguf | sha256sum --check
# Put this identifier in .env too when using this community artifact:
export ELYTRA_GUARD_VERSION=QuantFactory/Qwen3Guard-Gen-0.6B:be4e562:Q8_0:a5108bc2
```

This is a third-party artifact; the checksum establishes the artifact tested,
not equivalence to an independently reproduced conversion. GGUFs and datasets
are ignored by Git. Set `ELYTRA_GUARD_VERSION` to identify the exact artifact you
deploy, especially after changing revision or quantization.

### Backend details

The profiles use llama.cpp's
[official server images](https://github.com/ggml-org/llama.cpp/blob/master/docs/docker.md).
All use one slot, 4,096-token context, four CPU threads, and a 64 MiB prompt-cache
budget. GPU profiles request full layer offload; CPU explicitly disables it.

- **CPU:** `server`. AVX2 is sufficient; AVX-512 is not required. The CPU build
  tested here used `GGML_NATIVE=OFF`, AVX2 on, and AVX-512 off. On a four-core
  host, lower the profile's thread counts to 2–3 if guard work affects web latency.
- **CUDA:** `server-cuda`, `gpus: all`. Install NVIDIA drivers and NVIDIA Container
  Toolkit. The RTX 3050 6 GB has ample space for this Q8 model and short context;
  CUDA execution was not tested on this machine.
- **ROCm:** `server-rocm`, `/dev/kfd` and `/dev/dri`. Use an AMD GPU and drivers
  supported by the image's ROCm version. Set `ELYTRA_RENDER_GID` and
  `ELYTRA_VIDEO_GID` to your host's group IDs (`getent group render video`).
- **Vulkan:** `server-vulkan`, `/dev/dri`, matching render/video groups. Install
  the host Vulkan driver for the GPU. AMD/Intel render nodes use the supplied
  device mappings. NVIDIA Vulkan deployments additionally need NVIDIA container
  driver injection and graphics capabilities; use CUDA for the simplest NVIDIA
  setup. Vulkan execution was not tested here.

Image tags float with upstream. Each profile has an `ELYTRA_GUARD_*_IMAGE`
override; pin an image digest after validating your deployment. Check server logs
for the selected device/offloaded layers rather than assuming a GPU was used.
ROCm and Vulkan builds can vary with driver support. No Node native addons or
external cloud inference are involved.

Without Docker, run a suitable local `llama-server` binary:

```sh
llama-server --model /path/to/qwen3guard-q8_0.gguf --host 127.0.0.1 --port 8081 \
  --ctx-size 4096 --parallel 1 --threads 4 --threads-batch 4 \
  --gpu-layers 0 --cache-ram 64 --no-webui
```

Use a CUDA, HIP/ROCm, or Vulkan build and `--gpu-layers 99` for acceleration.
Keep the unauthenticated endpoint on loopback/private networking.

## Tier 0: local slur matching

Tier 0 uses a handwritten TypeScript Aho–Corasick matcher with no new runtime
package. It is built at server startup and reused across route/action bundles.
The encoded seed contains **79 English entries** tagged with term, severity,
category, word/substr matching mode, language, exceptions, and source. Ordinary
profanity is excluded. This is a curated vocabulary, not an imported profanity
blocklist. The base64 data file is `src/server/moderation/slur-seed.ts`; encoding
keeps casual source browsing unobtrusive and is not secrecy or encryption.

All seed entries use **word** matching. No seed term received a substring flag,
so there are no unaudited substring terms. This prevents innocent embedded
syllables from matching. Reclaimed, regional, food, animal, and other dual-meaning
entries are marked `ambiguous`; they cannot cause a name rejection, review hold,
or reach reduction by themselves. Tier 1 receives high/ambiguous/category feature
namespaces during training and inference; Qwen receives lexical counts and a
context reminder. Ambiguous hits only influence escalation if the classifier
also signals risk (or the independently selected `all` mode requests guard
classification). High hits escalate in `borderline`; explicit `off` still wins.

Category source references are retained on every decoded entry:

| Category | Sources used to select factual vocabulary |
| --- | --- |
| Racial/ethnic | [Wikipedia ethnic slurs](https://en.wikipedia.org/wiki/List_of_ethnic_slurs) |
| Antisemitic | [Wikipedia religious slurs](https://en.wikipedia.org/wiki/List_of_religious_slurs) |
| Anti-Muslim | [Wikipedia religious slurs](https://en.wikipedia.org/wiki/List_of_religious_slurs) |
| Homophobic | [Wikipedia LGBTQ slang](https://en.wikipedia.org/wiki/LGBTQ_slang) |
| Transphobic | [Wikipedia LGBTQ slang](https://en.wikipedia.org/wiki/LGBTQ_slang) |
| Ableist | [Wikipedia disability-related terms](https://en.wikipedia.org/wiki/List_of_disability-related_terms_with_negative_connotations) |
| Misogynistic | Wiktionary [femoid](https://en.wiktionary.org/wiki/femoid), [roastie](https://en.wiktionary.org/wiki/roastie), and Wikipedia [Feminazi](https://en.wikipedia.org/wiki/Feminazi) |

Definitions and article prose are not copied. Severity and exception choices are
Elytra policy decisions, not claims that any source prescribes automatic removal.

### Normalization and original spans

The shared pipeline applies NFKC, full default Unicode case folding, NFD and
combining-mark removal, invisible/default-ignorable removal (including U+200B–D,
U+2060, U+FEFF and soft hyphens), and a vendored Latin-target subset of Unicode
16.0's [TR39 confusables](https://www.unicode.org/Public/security/16.0.0/confusables.txt).
The subset contains 437 mappings plus 211 case-fold mappings that differ from
simple lowercasing; see `unicode-data.ts` and the retained Unicode license.
The vendored file can be regenerated with `python3 scripts/update-moderation-unicode.py`;
retrain afterward. This is a deliberately restricted text-matching skeleton, not full TR39 identifier
security conformance. TR39 maps Latin `m` to `rn`, among other expansions.

Unambiguous leet substitutions are 4→a, 3→e, 0→o, $→s, and @→a. The digit 1 is
represented as a class accepting i or l, and ! can be i or literal punctuation;
neither is guessed as one specific letter. Automaton class-state sets are bounded
by trie size instead of expanding all whole-string spellings.

The matcher scans original and collapsed forms, joins runs of at least three
single letters split by spaces/punctuation, and splits hashtag camelCase and
underscores before word matching. Repetition counts must agree with the entry
unless the input repeats that letter three or more times. This catches extended
runs without reducing an ordinary one-letter spelling to an entry that requires
a doubled letter. Source-level collapse handles multi-character skeletons too.
Known phrase exceptions suppress only the contained occurrence, not other hits
elsewhere in the post. Names use substring matching and ignore exceptions, but
**only high-severity entries can reject a name**, per the chosen policy.

Every hit records the matched entry and half-open UTF-16 `start`/`end` offsets into
the original input. `original.slice(start, end)` recovers the exact evasion,
including internal separators, invisible characters, combining marks, or surrogate
pairs. Offsets in normalized views map back through expansions and collapses.

### Live admin overrides

`moderation_slur_overrides` merges over the seed by normalized term and language.
Changes increment a database version counter; the next check rebuilds the cached
matcher without a deploy. Add extra terms or phrase exceptions, change metadata,
or disable a seed entry. Exceptions are unioned with the seed's exceptions. A
new term needs severity and category; an existing entry may inherit them.
Invalid edits keep the last valid matcher and log a single diagnostic for that
version. The dictionary is bounded to 4,096 merged entries.

For an explicit local ban, set `reject_publish=1` on an enabled override. With
`ELYTRA_MODERATION_PUBLISH=block`, a matched term is then rejected before either
model runs, including when the guard is unavailable or would return Safe.
The composer uses `This content isn't allowed`; a tier 0 audit row records
`rejected_publish_term`, the entry, and its original span. This is an explicit
operator decision overriding contextual treatment for that selected term; it
does not change the seed's severity, name policy, or trained features. Word
boundaries, existing phrase exceptions, and evasion normalization still apply.
The default is `0`. Set it back to `0` (or disable the entry) to restore model
handling immediately, without restarting or deploying.

For example, using a deliberately harmless placeholder:

```sql
INSERT INTO moderation_slur_overrides(term,lang,severity,category,exceptions,source)
VALUES('zorp','en','high','racial_ethnic','["Project zorp"]','local admin review');
-- Optionally reject this selected term immediately in blocking publication mode:
UPDATE moderation_slur_overrides SET reject_publish=1 WHERE term='zorp' AND lang='en';
-- Add an exception to an existing entry with the same term/lang; metadata can inherit.
-- Disable a local or seeded entry:
UPDATE moderation_slur_overrides SET enabled=0 WHERE term='zorp' AND lang='en';
```

The default `match` is `word`. An administrator choosing `substring` must first
check the term inside an ordinary English word list and record the list/check
reference in `substring_audit`; the matcher refuses a substring entry without
that audit field. Prefer word boundaries and targeted exceptions. No seed entry
currently needs a word-list substring exemption. Overrides affect future scoring;
already recorded revisions and review decisions are retained for audit.

### Review and name policy

`ELYTRA_SLUR_ACTION=shadow` only records high-hit review recommendations.
`review` enables reversible holds for high-severity replies/mentions aimed at an
existing **other** user, and reach reduction for high-severity top-level posts.
Held posts are omitted from public detail/thread/feed/search rendering while
remaining in SQLite. Other top-level posts retain direct/profile/Following access
while being removed from For You, trending, and search. An occurrence alone does
not establish intent; the review queue exists for quotations and discussion.

`reject-directed` optionally rejects high-severity directed posts synchronously,
before publication, with `This post contains a term that isn't allowed` in the
composer/API. It does not reject ambiguous hits. Self-replies and unknown or
self-only mentions are not classified as directed at another user. Rejections
are audited as tier 0 with a candidate/rejected item id and no duplicated text.

`ELYTRA_SLUR_NAMES=reject` (the default when moderation is enabled) rejects
high-severity substrings in usernames at signup and display names at signup/edit.
The policy ignores word boundaries and exceptions in names. Ambiguous/reclaimed
name hits are allowed. Set `off` to disable this exception to shadow mode.

`moderation_reviews` records pending recommendations, with `hold` or `reduce_reach`.
A strictly parsed `Safe` Qwen result approves a pending lexical review; `Unsafe`
confirms it as restricted. `Controversial`, unknown, timeout, or missing guard
leave it pending for a reviewer. A late result never changes an already reviewed
state. Turning slur actions to `shadow` restores visibility without erasing audit
history. Operators can review directly in SQLite; no admin UI is included:

```sql
SELECT r.*,p.content FROM moderation_reviews r JOIN posts p ON p.id=r.item_id
WHERE r.state='pending' ORDER BY r.created_at;
UPDATE moderation_reviews SET state='approved',reviewed_at=unixepoch()*1000
WHERE revision='REVIEW_REVISION';
-- 'restricted' confirms the existing hold/reach recommendation; never deletes.
```

Neither an ambiguous lexical hit nor `Controversial` triggers an automatic action.
Real local Qwen tests still flagged some benign reclaimed/regional phrases as
Controversial or Unsafe. Shadow mode is recommended; the separate guard discovery
rule additionally requires a high independent linear score. The system is not a
reliable intent detector, and no term matcher can determine quotation or reclamation
on its own.

## Configuration

Restart the app after changing configuration or replacing weights. Standalone
Docker builds explicitly copy the bundled linear weights into the runner.
For custom Docker weights, bind-mount the file and set its container path.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ELYTRA_MODERATION` | `false` | Opt in to scoring and the background worker |
| `ELYTRA_MODERATION_ESCALATION` | `borderline` | `off`, `borderline`, or `all` |
| `ELYTRA_MODERATION_LOW` / `HIGH` | `0.2` / `0.8` | Inclusive uncertain band; **any label** in the band escalates |
| `ELYTRA_MODERATION_WEIGHTS` | `models/moderation/linear.json` | int8 weights JSON; loaded once per process |
| `ELYTRA_MODERATION_ENFORCEMENT` | `off` | `off` records only for the guard policy; `discovery` enables the narrow reversible rule below |
| `ELYTRA_MODERATION_PUBLISH` | `off` | `block` checks every post/reply/quote before publication and rejects Unsafe; unknown keeps draft for retry |
| `ELYTRA_SLUR_ACTION` | `shadow` | `shadow`, `review`, or `reject-directed`; high-severity post policy |
| `ELYTRA_SLUR_NAMES` | `reject` | Reject high-severity name substrings when moderation is enabled; `off` disables |
| `ELYTRA_MODERATION_ENFORCE_MIN` | `0.95` | Minimum maximum tier 1 score for discovery exclusion |
| `ELYTRA_GUARD_URL` | `http://127.0.0.1:8081` | Trusted local server base URL; overlay uses `http://guard:8081` |
| `ELYTRA_GUARD_BACKEND` | `cpu` | `guard:up` selects CPU/CUDA/ROCm/Vulkan profile; does not launch a server from Node |
| `ELYTRA_GUARD_VERSION` | `Qwen3Guard-Gen-0.6B:fada3b2:Q8_0` | Audit artifact/version identifier |
| `ELYTRA_GUARD_TIMEOUT_MS` | `5000` | HTTP deadline including response body; also maximum queue wait |
| `ELYTRA_GUARD_QUEUE` | `16` | Waiting guard jobs, in addition to one active request; max 256 |
| `ELYTRA_GUARD_FAILURES` | `3` | Consecutive HTTP/timeout/malformed failures before opening circuit |
| `ELYTRA_GUARD_COOLDOWN_MS` | `30000` | Circuit cooldown, then one recovery probe |
| `ELYTRA_GUARD_MODELS_DIR` | `./data/moderation-models` | Compose model directory, mounted read-only |
| `ELYTRA_GUARD_CPU_IMAGE` / `CUDA_IMAGE` / `ROCM_IMAGE` / `VULKAN_IMAGE` | upstream server tags | Image/digest overrides; each full name starts `ELYTRA_GUARD_` |
| `ELYTRA_RENDER_GID` / `ELYTRA_VIDEO_GID` | `109` / `44` | Compose AMD/Vulkan device groups; use host values |

`borderline` normally sends uncertain classifier scores. High-severity tier 0
hits also escalate; ambiguous hits need a classifier signal. Use `all` when every item needs the
guard's broader taxonomy, or to require guard confirmation for high-score items.
Tier 1 models toxicity, severe toxicity, obscenity, threat, insult, identity
attack, and sexually explicit content. It cannot reliably gate every guard
category (e.g. PII or copyright); its training is mostly English, so `all` also
provides more multilingual coverage.

A guard deadline and a queue wait are separate budgets: a waiting request may
spend up to twice `TIMEOUT_MS` in total. Saturation, queue expiry, circuit-open,
network errors, malformed output, and response bodies above 8 KiB record tier 2
`unknown` with a status. There is no unsafe fallback. Tier 1 scoring continues.
Missing/invalid linear weights record `weights_unavailable` with empty scores
and perform no linear-based enforcement. Tier 0 review/name policy is independent.

## Storage, worker, and reversible actions

SQLite triggers enqueue text inside the same transaction as the public write.
Rollback leaves no job. The Node instrumentation hook starts an unref'ed 250 ms
poller on this single-host, long-lived server. Each tick handles at most 32 items;
this bounds local tier 0/1 work per event-loop turn (up to about 128 items/sec before
other load). Guard admission is process-wide via `sharedCapacity`: one active
HTTP request and a bounded FIFO. Overflow records `unknown` and retains the tier
1 result. Publishing only adds a small SQLite outbox write; it waits for neither
classifier nor guard.

The outbox is durable on disk, not an unbounded collection of promises. Pending
tier 1 or guard jobs resume after restart; HTTP may be repeated if a process dies
before committing its result. The `(revision,tier)` key prevents duplicate audit
rows. A burst larger than the poller can drain can grow the disk outbox; monitor
its count. There are no automatic network retries for completed failed requests.

`moderation_results` stores item id/type, revision, SHA-256 of the original text,
tier (0/1/2), tier 0 matched entries/original spans, per-label scores, guard
verdict/categories, model/weights/lexicon versions, status, latency, and time. Each profile field revision has its own audit entry. Results
do not duplicate plaintext; pending jobs temporarily contain it. Results are
retained until the corresponding item is deleted or the operator prunes them.
Deleting an item erases pending/audit rows; in-flight completions cannot recreate
them. Include these tables in normal SQLite backups.

Optional `discovery` enforcement requires **all** of: guard status `ok`, verdict
`Unsafe`, category Violent or Unethical Acts, and a tier 1 score at least
`ENFORCE_MIN`. It inserts `moderation_exclusions`; posts remain available on
detail pages, profiles, Following, and bookmarks. For You, trending counts, and
post search exclude them, including existing paginated snapshots. Profiles are
scored only and never hidden. No content is deleted by moderation. There is no
admin UI or report system.

Turning guard enforcement `off` and slur actions to `shadow` (or moderation off)
restores visibility immediately on restart. An operator can also reverse an individual exclusion:

```sql
SELECT item_id,item_type,tier,scores,guard_verdict,guard_categories,status,latency_ms
FROM moderation_results ORDER BY id DESC LIMIT 100;
SELECT count(*) AS pending FROM moderation_jobs;
DELETE FROM moderation_exclusions WHERE post_id = 'ITEM_ID';
```

Old exclusions are not automatically recalculated after retraining. Review or
clear them deliberately. Never base an action solely on identity mentions,
Controversial, or an unknown/failed result.

## Retraining and bias checks

[TensorFlow's Civil Comments catalog](https://www.tensorflow.org/datasets/catalog/civil_comments)
identifies the dataset as the Jigsaw Unintended Bias release and states that
both labels and underlying text are CC0. This is preferred to the original
Jigsaw set. Downloading from the public release avoids a Kaggle credential
requirement. Do not commit training comments.

```sh
# Python/pyarrow are preparation-only, not app dependencies.
python3 -m venv /tmp/elytra-training-env
/tmp/elytra-training-env/bin/pip install pyarrow
/tmp/elytra-training-env/bin/python scripts/prepare-moderation-data.py /tmp/elytra-training-data
npm run train:moderation -- /tmp/elytra-training-data/civil-comments.jsonl
# Optional: MODERATION_TRAIN_ROWS=1804874 MODERATION_TRAIN_EPOCHS=5
# Download both shards with prepare-moderation-data.py ... --shards 2 first.
npm run test:moderation
```

The trainer uses only Node built-ins and shared TypeScript features: hashed
character 2–5 grams, word unigrams/bigrams, binary L2-normalized features, and
tier 0 high/ambiguous/category signals, and seven independent logistic heads with AdaGrad and soft annotator labels. The
artifact is quantized to int8 with a separate scale per head. Training streams
JSONL every epoch rather than keeping the corpus in RAM. Defaults use the first
250,000 rows, with identical normalized texts assigned to the same deterministic
90/10 train/holdout partition. A normalized-text hash avoids duplicate text
leaking across that split.

Short neutral identity counterfactuals are interleaved at 2% to reduce the
long-comment/short-post bias. The artifact includes the training digest and feature-code SHA-256,
augmentation version, holdout counts and Brier scores for each label, conservative
0.95-threshold false positives/recall, identity sanity probes, and a non-toxic
identity-mention proxy. The bundled model trained on 224,889 public examples
plus the augmentation; 25,111 public examples are held out. See the
[weight model notes](../models/moderation/README.md) for measured limitations.

The identity proxy had 0/163 flags at 0.95; this sample is too small to establish
fairness. Simple probes can overlap augmentation and are not validation data.
Toxicity at 0.95 caught only 44/1,971 positive holdout examples with 2/23,140 false
positives. This threshold intentionally sacrifices recall. No full Jigsaw
subgroup/BPSN/BNSP AUC audit or community calibration was performed. Preserve
identity-negative examples and run those audits before enabling enforcement;
choosing the newer dataset alone does not remove bias. A tiny linear English
model is an escalation signal, not a comprehensive safety model.

## Benchmarks and verification

```sh
npm run test:moderation
npm run bench:moderation
# Optional budgets and JSON output:
ELYTRA_BENCH_LINEAR_ITEMS=50000 ELYTRA_BENCH_GUARD_ITEMS=32 npm run bench:moderation -- --output=/tmp/moderation-bench.json
```

Benchmarking includes normalization/features and sequential inference, and guard
HTTP with prefix caching. It excludes SQLite writes and outbox polling delay.
Linear timings reuse the already computed tier 0 hits, as the worker does.
An unavailable guard is reported explicitly as skipped; unknown responses are
counted separately from valid classifications.

The moderation test script has 28 check groups, including 65 false-positive
fixtures and 61 evasion fixtures with exact original-span assertions. It covers
live overrides, high-only name rejection, shadow behavior, reversible review
actions, migrations, durable jobs, bounded guard admission, deadlines, circuit
recovery, strict parsing, missing-sidecar fallback, and blocking publication
with no rejected-post side effects or duplicate guard work.
An additional encoded publication fixture covers 36 explicit-ban spellings and
evasions plus 13 allowed word-boundary/context cases, tested independently of
the guard's verdict. Migration and live reversal of these rules are covered.

On the development machine (Ryzen 7 7700, Node 26.10, Linux, **CPU AVX2 build,
four threads**, Q8_0), a run measured:

| Tier | Samples | Mean | p95 | Sequential throughput |
| --- | --- | --- | --- | --- |
| Slur matcher | 20,000 | 11.92 µs | 38.02 µs | 83,484 items/sec |
| Linear | 20,000 | 14.19 µs | 47.58 µs | 70,188 items/sec |
| Guard | 28 | 415 ms | 511 ms | 2.41 items/sec |

All 28 measured guard responses parsed successfully. The report is at
[2026-10-15-moderation-cpu.json](benchmarks/2026-10-15-moderation-cpu.json).
The GGUF is 804,753,408 bytes (~767 MiB). Observed llama-server RSS was about
1.28 GiB with the 4,096 context; the linear decoded array is 224 KiB, with a
~302 KiB JSON artifact and transient feature allocations. CPU resident memory
includes weights, KV cache, and server buffers. Conversion can require several
GiB of RAM/disk. For GPU operation budget roughly 1–2 GiB for weights/context
and overhead; this is an estimate, not a measured CUDA/ROCm/Vulkan allocation.

The i7-4770K will be slower than this development CPU; these timings do not claim
to measure that server or the RTX 3050. Keep one guard slot and borderline
escalation on constrained hosts. CPU serving, cache-enabled requests, the app
with moderation disabled, the app with a real sidecar, and the app with an
unreachable sidecar were exercised. Docker execution and CUDA/ROCm/Vulkan
acceleration were not verified locally. No full conversion from safetensors was
run; the pinned community Q8 artifact was used for runtime verification.
