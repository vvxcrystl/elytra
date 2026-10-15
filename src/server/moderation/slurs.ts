import { collapseLetters, isWord, joinSplitLetters, normalizeMapped, normalizeText, characterClass, type MappedText } from "./normalize";
import { SEED_BASE64, SEED_VERSION } from "./slur-seed";

export const SLUR_CATEGORIES = ["racial_ethnic", "antisemitic", "anti_muslim", "homophobic", "transphobic", "ableist", "misogynistic"] as const;
export type SlurEntry = { term: string; severity: "high" | "ambiguous"; category: string; match: "word" | "substring"; lang: string; exceptions: string[]; source: string; substringAudit?: string };
export type SlurHit = { entry: SlurEntry; start: number; end: number };
export type SlurSignals = { high: number; ambiguous: number; categories: string[] };
export function slurSignals(hits: readonly SlurHit[]): SlurSignals {
  return { high: hits.filter(h => h.entry.severity === "high").length, ambiguous: hits.filter(h => h.entry.severity === "ambiguous").length,
    categories: [...new Set(hits.map(h => h.entry.category))].sort() };
}
export function validateEntry(entry: SlurEntry): void {
  if (!entry || typeof entry.term !== "string" || entry.term.length < 2 || entry.term.length > 80 ||
      !["high", "ambiguous"].includes(entry.severity) || !["word", "substring"].includes(entry.match ?? "word") ||
      !(SLUR_CATEGORIES as readonly string[]).includes(entry.category) || typeof entry.lang !== "string" ||
      !/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(entry.lang) || !Array.isArray(entry.exceptions) || entry.exceptions.length > 100 ||
      entry.exceptions.some(e => typeof e !== "string" || e.length < 2 || e.length > 160) || typeof entry.source !== "string" ||
      (entry.match === "substring" && !entry.substringAudit)) throw new Error("Invalid slur entry or missing substring word-list audit");
}
export const seedEntries = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(SEED_BASE64), c => c.charCodeAt(0)))) as SlurEntry[];

type Pattern = { entry: number; length: number; counts?: number[]; exception: boolean };
type Node = { next: Map<string, number>; failure: number; output: Pattern[] };
/** Aho-Corasick trie/failure links; built once, then linear scans with bounded class states. */
class Automaton {
  nodes: Node[] = [{ next: new Map(), failure: 0, output: [] }];
  add(text: string, pattern: Pattern) {
    if (!text) return;
    let node = 0;
    for (const c of text) {
      let next = this.nodes[node].next.get(c);
      if (next === undefined) { next = this.nodes.length; this.nodes.push({ next: new Map(), failure: 0, output: [] }); this.nodes[node].next.set(c, next); }
      node = next;
    }
    this.nodes[node].output.push(pattern);
  }
  build() {
    const queue = [...this.nodes[0].next.values()];
    for (let i = 0; i < queue.length; i++) for (const [c, child] of this.nodes[queue[i]].next) {
      let f = this.nodes[queue[i]].failure;
      while (f && !this.nodes[f].next.has(c)) f = this.nodes[f].failure;
      this.nodes[child].failure = this.nodes[f].next.get(c) ?? 0;
      this.nodes[child].output.push(...this.nodes[this.nodes[child].failure].output);
      queue.push(child);
    }
  }
  step(state: number, c: string): number {
    while (state && !this.nodes[state].next.has(c)) state = this.nodes[state].failure;
    return this.nodes[state].next.get(c) ?? 0;
  }
  scan(view: MappedText, emit: (pattern: Pattern, start: number, end: number) => void) {
    let state = 0, states: Set<number> | undefined;
    for (let i = 0; i < view.text.length; i++) {
      const c = view.text[i];
      if (!states && c !== "1" && c !== "!") {
        state = this.step(state, c);
        for (const p of this.nodes[state].output) emit(p, i - p.length + 1, i);
      } else {
        const next = new Set<number>();
        for (const s of states ?? [state]) for (const option of characterClass(c)) next.add(this.step(s, option));
        for (const s of next) for (const p of this.nodes[s].output) emit(p, i - p.length + 1, i);
        if (next.size === 1) { state = next.values().next().value!; states = undefined; } else states = next;
      }
    }
  }
}
function boundary(view: MappedText, start: number, end: number): boolean {
  const before = start > 0 ? String.fromCodePoint(view.text.codePointAt(start >= 2 && /[\udc00-\udfff]/.test(view.text[start - 1]) ? start - 2 : start - 1)!) : "";
  const after = end + 1 < view.text.length ? String.fromCodePoint(view.text.codePointAt(end + 1)!) : "";
  return !isWord(before) && !isWord(after);
}
export class SlurMatcher {
  private raw = new Automaton();
  private folded = new Automaton();
  readonly entries: readonly SlurEntry[];
  readonly version: string;
  constructor(entries: readonly SlurEntry[] = seedEntries, version = SEED_VERSION) {
    this.version = version;
    if (entries.length > 4096) throw new Error("Slur lexicon exceeds 4096 entries");
    this.entries = entries.map(entry => ({ ...entry, match: entry.match ?? "word", exceptions: [...entry.exceptions] }));
    this.entries.forEach((entry, index) => {
      validateEntry(entry);
      for (const [text, exception] of [[entry.term, false] as const, ...entry.exceptions.map(e => [e, true] as const)]) {
        const original = normalizeMapped(text);
        this.raw.add(original.text, { entry: index, exception, length: original.text.length });
        const folded = collapseLetters(original, true);
        this.folded.add(folded.text, { entry: index, exception, length: folded.text.length, counts: folded.repeats });
      }
    });
    this.raw.build(); this.folded.build();
  }
  match(text: string, names = false, prepared?: MappedText): SlurHit[] {
    const base = prepared ?? normalizeMapped(text, !names), joined = joinSplitLetters(base);
    const found: SlurHit[] = [], exceptions: { entry: SlurEntry; start: number; end: number }[] = [];
    const scan = (view: MappedText, automaton: Automaton) => automaton.scan(view, (p, start, end) => {
      if (start < 0) return;
      const entry = this.entries[p.entry];
      if ((!names || p.exception) && (p.exception || entry.match === "word") && !boundary(view, start, end)) return;
      if (p.counts && p.counts.some((count, i) => view.repeats[start + i] !== count && view.repeats[start + i] < 3)) return;
      const hit = { entry, start: view.offsets[start].start, end: view.offsets[end].end };
      if (p.exception) { if (!names) exceptions.push(hit); } else found.push(hit);
    });
    const views = joined === base ? [base] : [base, joined];
    // Collapse source runs too: a single Latin m expands to rn in a TR39 skeleton.
    if (/(.)\1{2,}/iu.test(text.normalize("NFKC")) || /(?:rn){3,}/.test(base.text)) {
      const sourceCollapsed = normalizeMapped(text, !names, true);
      if (sourceCollapsed.text !== base.text) views.push(sourceCollapsed, joinSplitLetters(sourceCollapsed));
    }
    for (const view of views) {
      scan(view, this.raw); scan(collapseLetters(view, true), this.folded);
    }
    const accepted = found.filter(hit => names || !exceptions.some(e => e.entry === hit.entry && e.start <= hit.start && e.end >= hit.end));
    // Prefer the full evasion span over overlapping raw/collapsed duplicates.
    const unique: SlurHit[] = [];
    for (const hit of accepted.sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (!unique.some(h => h.entry === hit.entry && h.start <= hit.start && h.end >= hit.end)) unique.push(hit);
    }
    return unique;
  }
}
const shared = globalThis as typeof globalThis & { elytraSeedSlurMatcher?: SlurMatcher };
const seedMatcher = shared.elytraSeedSlurMatcher ??= new SlurMatcher();
export const getSeedMatcher = () => seedMatcher;
export { normalizeText };
