import { CASE_FOLDS, LATIN_SKELETON } from "./unicode-data";

export const NORMALIZER_VERSION = "unicode16-tr39-latin-v2";
export type Offset = { start: number; end: number };
export type MappedText = { text: string; offsets: Offset[]; repeats: number[] };
const marks = /\p{M}/gu;
const invisible = /\p{Default_Ignorable_Code_Point}/gu;
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const leet: Record<string, string> = { "4": "a", "3": "e", "0": "o", "$": "s", "@": "a" };
export const characterClass = (c: string): readonly string[] => c === "1" ? ["1", "i", "l"] : c === "!" ? ["!", "i"] : [c];
export const isWord = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}_]/u.test(c);
function casefoldBase(text: string): string {
  let result = "";
  for (const c of text.normalize("NFKC")) result += CASE_FOLDS[c] ?? c.toLowerCase();
  result = result.normalize("NFD").replace(marks, "").replace(invisible, "");
  return result;
}
function fold(text: string): string {
  const result = casefoldBase(text);
  let skeleton = "";
  for (const c of result) {
    // 1 and ! remain explicit classes, never guessed as a particular letter.
    skeleton += c === "1" || c === "!" ? c : leet[c] ?? LATIN_SKELETON[c] ?? c;
  }
  return skeleton.replace(marks, "");
}
function append(out: MappedText, text: string, start: number, end: number) {
  for (const c of text) {
    const value = /\s/u.test(c) ? " " : c;
    if (value === " " && out.text.endsWith(" ")) { out.offsets[out.offsets.length - 1].end = end; continue; }
    out.text += value;
    for (let i = 0; i < value.length; i++) { out.offsets.push({ start, end }); out.repeats.push(1); }
  }
}
/** Offsets are half-open UTF-16 indices, directly usable with original.slice(start,end). */
export function normalizeMapped(text: string, hashtags = false, collapseSourceRuns = false): MappedText {
  const out: MappedText = { text: "", offsets: [], repeats: [] };
  const hashtagOffsets = new Set<number>(), boundaries = new Set<number>();
  if (hashtags) for (const match of text.matchAll(/#[\p{L}\p{N}_]+/gu)) {
    const start = match.index;
    for (let i = start; i < start + match[0].length; i++) {
      hashtagOffsets.add(i);
      if (/[\p{Ll}\p{N}]/u.test(text[i - 1] ?? "") && /\p{Lu}/u.test(text[i])) boundaries.add(i);
      if (/\p{Lu}/u.test(text[i - 1] ?? "") && /\p{Lu}/u.test(text[i]) && /\p{Ll}/u.test(text[i + 1] ?? "")) boundaries.add(i);
    }
  }
  // ASCII hot path avoids grapheme segmentation on ordinary posts.
  if (/^[\x00-\x7f]*$/.test(text)) {
    for (let i = 0; i < text.length; i++) {
      if (boundaries.has(i)) append(out, " ", i, i);
      const c = text[i].toLowerCase();
      let end = i + 1;
      if (collapseSourceRuns && /[a-z1!]/.test(c)) while (text[end]?.toLowerCase() === c) end++;
      if (end - i < 3) end = i + 1;
      const before = out.offsets.length;
      append(out, hashtagOffsets.has(i) && c === "_" ? " " : (c === "1" || c === "!" ? c : leet[c] ?? LATIN_SKELETON[c] ?? c), i, end);
      for (let j = before; j < out.repeats.length; j++) out.repeats[j] = end - i;
      i = end - 1;
    }
  } else {
    const segments = [...segmenter.segment(text)];
    for (let i = 0; i < segments.length; i++) {
      const { segment, index } = segments[i], key = casefoldBase(segment);
      if (boundaries.has(index)) append(out, " ", index, index);
      let end = i + 1, count = 1;
      if (collapseSourceRuns && /^[\p{L}1!]$/u.test(key)) {
        for (let cursor = i + 1; cursor < segments.length; cursor++) {
          const next = casefoldBase(segments[cursor].segment);
          if (!next) continue;
          if (next !== key) break;
          count++; end = cursor + 1;
        }
      }
      if (count < 3) { end = i + 1; count = 1; }
      const before = out.offsets.length, last = segments[end - 1];
      append(out, hashtagOffsets.has(index) && segment === "_" ? " " : fold(segment), index, last.index + last.segment.length);
      for (let j = before; j < out.repeats.length; j++) out.repeats[j] = count;
      i = end - 1;
    }
  }
  return out;
}
/** Join maximal runs of at least three single letters, preserving the entire source span. */
export function joinSplitLetters(view: MappedText): MappedText {
  const remove = new Set<number>();
  const words = [...view.text.matchAll(/[\p{L}\p{N}]+/gu)];
  const single = (m: RegExpMatchArray) => {
    const index = m.index!;
    return m[0].length === 1 || [...m[0]].every((_, n) => view.offsets[index + n].start === view.offsets[index].start && view.offsets[index + n].end === view.offsets[index].end);
  };
  for (let i = 0; i < words.length;) {
    if (!single(words[i])) { i++; continue; }
    let end = i + 1;
    while (end < words.length && single(words[end]) && /^[\s\p{P}\p{S}]+$/u.test(view.text.slice(words[end - 1].index! + words[end - 1][0].length, words[end].index))) end++;
    if (end - i >= 3) for (let j = i; j < end - 1; j++) {
      for (let k = words[j].index! + words[j][0].length; k < words[j + 1].index!; k++) remove.add(k);
    }
    i = end;
  }
  if (!remove.size) return view;
  const out: MappedText = { text: "", offsets: [], repeats: [] };
  for (let i = 0; i < view.text.length; i++) if (!remove.has(i)) {
    out.text += view.text[i]; out.offsets.push(view.offsets[i]); out.repeats.push(view.repeats[i]);
  }
  return out;
}
/** allRuns is matcher-only; multiplicity checks prevent e.g. one g matching a two-g entry. */
export function collapseLetters(view: MappedText, allRuns = false): MappedText {
  const out: MappedText = { text: "", offsets: [], repeats: [] };
  for (let i = 0; i < view.text.length;) {
    let end = i + 1;
    if (/[\p{L}1!]/u.test(view.text[i])) while (view.text[end] === view.text[i]) end++;
    const count = view.repeats.slice(i, end).reduce((a, b) => a + b, 0), keep = allRuns ? 1 : end - i >= 3 ? 2 : end - i;
    for (let n = 0; n < keep; n++) {
      out.text += view.text[i];
      out.offsets.push({ start: view.offsets[i].start, end: view.offsets[end - 1].end }); out.repeats.push(count);
    }
    i = end;
  }
  return out;
}
export function normalizedReading(view: MappedText): string { return collapseLetters(joinSplitLetters(view)).text.trim(); }
export function normalizeText(text: string): string { return normalizedReading(normalizeMapped(text)); }
