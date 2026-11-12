/**
 * Applies the drafter's suggested rewrite of a vague condition to the deal
 * text the payer wrote, and tracks the blanks a rewrite leaves for the payer
 * to fill in. Pure functions, used by the composer.
 *
 * The rewrite is a full sentence ("The submitted page shows ..."), so it is
 * never spliced into the middle of the payer's sentence. The vague wording is
 * taken out where that leaves well-formed text (a whole sentence, an item of a
 * list, a clause after "and", a relative clause, an adjective) and the rewrite
 * is added as a sentence of its own after it. Where the wording cannot be cut
 * out cleanly, the sentence holding it is dropped whole, unless it also states
 * terms (an amount, a deadline), which are never lost: then it stays as it is.
 */

/** The fields of a drafter refusal this module needs. A null rewrite means "drop the condition". */
export interface RewriteSuggestion {
  condition: string;
  suggested_rewrite: string | null;
}

/** A blank the drafter leaves in a rewrite, e.g. `[your studio's name]`; not a CSS attribute selector such as `input[type=email]`. */
const BLANK = /(?<![\w\]])\[[^[\]\n]{2,80}\]/g;

/** The blanks in a suggested rewrite, in order, each as written (brackets included). */
export function blanksIn(rewrite: string | null): string[] {
  return rewrite ? (rewrite.match(BLANK) ?? []) : [];
}

/**
 * The first of `blanks` (strings a rewrite inserted) still in the deal, or
 * null. Text the payer typed is never a blank, however it is bracketed.
 */
export function firstBlank(deal: string, blanks: readonly string[]): { text: string; index: number } | null {
  let first: { text: string; index: number } | null = null;
  for (const text of blanks) {
    const index = deal.indexOf(text);
    if (index >= 0 && (first === null || index < first.index)) first = { text, index };
  }
  return first;
}

/** The deal with the vague condition taken out and its rewrite (if any) added as a sentence of its own. */
export function rewriteDeal(deal: string, v: RewriteSuggestion): string {
  const text = deal.trim();
  const rewrite = v.suggested_rewrite?.trim() ? asSentence(v.suggested_rewrite) : "";
  const found = locate(text, v.condition);
  if (!found) return joinSentences([text, rewrite && !contains(text, rewrite) ? rewrite : ""]);

  const [from, to] = sentenceAt(text, found.index);
  const sentence = text.slice(from, to);
  const edited = withoutPhrase(sentence, found.index - from, found.length);
  const kept = edited ?? (statesTerms(sentence) ? sentence : "");
  const head = text.slice(0, from).trim();
  const tail = text.slice(to).trim();
  const rest = joinSentences([head, kept, tail]);
  return joinSentences([head, kept, rewrite && !contains(rest, rewrite) ? rewrite : "", tail]);
}

// ---------------------------------------------------------------------------
// Finding the phrase
// ---------------------------------------------------------------------------

/** A lead-in that opens a sentence of conditions: "It must also", "The site should be", "Make sure it". */
const LEAD_IN =
  /^\s*(?:(?:also|and|plus|but|finally|additionally)\s*,?\s+)?(?:(?:(?:it|this|they|these|that|the(?:\s+[\w'-]+){1,3}|each\s+[\w-]+|every\s+[\w-]+|all\s+[\w-]+)\s+(?:must|should|shall|will|has\s+to|have\s+to|needs?\s+to|ought\s+to|is\s+to|are\s+to|is|are)|make\s+sure(?:\s+that)?\s+(?:it|they)|it'?s|it\s+is)(?:\s+also)?(?:\s+(?:be|look|feel|seem))?|also)?\s*$/i;

function cleanPhrase(condition: string): string {
  let phrase = condition.trim();
  // Quotes around the whole condition are the drafter's, not the payer's.
  if (/^["“'‘].*["”'’]$/.test(phrase)) phrase = phrase.slice(1, -1).trim();
  return phrase.replace(/[\s.!?,;:]+$/, "").trim();
}

/** Where the condition's wording is in the deal (ignoring case, spacing and quote style), or null. */
function locate(text: string, condition: string): { index: number; length: number } | null {
  const phrase = cleanPhrase(condition);
  if (!phrase) return null;
  // The drafter may quote the lead-in ("it must look professional") or not ("look professional").
  const withoutLeadIn = phrase.replace(/^(?:it|this|they|the\s+[\w'-]+)\s+(?:must|should|will|has\s+to|needs\s+to)(?:\s+also)?\s+/i, "");
  for (const candidate of new Set([phrase, withoutLeadIn])) {
    const pattern = candidate
      .split(/\s+/)
      .map((word) =>
        word
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/['‘’]/g, "['‘’]")
          .replace(/["“”]/g, '["“”]'),
      )
      .join("\\s+");
    const match = new RegExp(pattern, "i").exec(text);
    if (match) return { index: match.index, length: match[0].length };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|co|inc|ltd)$/i;

/** The [start, end) of the sentence holding `index`; the end includes its closing punctuation. */
function sentenceAt(text: string, index: number): [number, number] {
  let start = 0;
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === "“") quoted = true;
    else if (ch === "”") quoted = false;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (!quoted && depth === 0 && /[.!?]/.test(ch)) {
      let end = i + 1;
      while (end < text.length && /[.!?)"”']/.test(text[end])) end++;
      const atBoundary = end === text.length || /\s/.test(text[end]);
      if (!atBoundary || (ch === "." && ABBREVIATION.test(text.slice(start, i)))) continue;
      if (index < end) return [start, end];
      start = end;
      while (start < text.length && /\s/.test(text[start])) start++;
      i = start - 1;
    }
  }
  return [start, text.length];
}

function asSentence(rewrite: string): string {
  const s = rewrite.trim().replace(/[\s.]+$/, "");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[!?]$/.test(s) ? "" : "."}`;
}

/** Joins sentences with one space, ending each with a full stop if it has no closing punctuation. */
function joinSentences(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p, i, all) => (i < all.length - 1 && !/[.!?]["”')]*$/.test(p) ? `${p}.` : p))
    .join(" ");
}

/** Whether `text` already has `sentence` as one of its sentences (ignoring case and the closing stop). */
function contains(text: string, sentence: string): boolean {
  const norm = (s: string) => s.trim().replace(/[.!?]+$/, "").replace(/\s+/g, " ").toLowerCase();
  const want = norm(sentence);
  for (let from = 0; from < text.length; ) {
    const [start, end] = sentenceAt(text, from);
    if (norm(text.slice(start, end)) === want) return true;
    from = end + 1;
  }
  return false;
}

/** An amount or a deadline: a sentence stating one is never dropped. */
const TERMS =
  /[$€£₹¥]|\b(?:usd|eur|gbp|inr|cad|aud|dollars?|bucks|euros?|pounds?|rupees?|pay|paid|bounty|due|deadline|within)\b|\bin\s+\d+\s+(?:days?|weeks?|months?)\b|\bby\s+(?:next\s+|this\s+)?(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|tonight|the\s+end|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d)/i;

function statesTerms(sentence: string): boolean {
  return TERMS.test(sentence);
}

// ---------------------------------------------------------------------------
// Taking the phrase out of its sentence
// ---------------------------------------------------------------------------

/** A list's separator before its last item: ", and", " and", ", or", " or". */
const SEP_BEFORE_LAST = /(,?)\s+(?:and|or)\s+$/i;
/** A separator after an item: ", and ", ", ", " and ". */
const SEP_AFTER = /^\s*(?:,\s*(?:and|or)\s+|,\s*|\s+(?:and|or)\s+)/i;
/** Where the predicates of a list start: the list runs from after the last of these. */
const LIST_START = /\b(?:must|should|shall|will|has\s+to|have\s+to|needs?\s+to|that|which)\s+/gi;
/** Words that attach a clause or phrase to a noun: "a site that looks good", "a site with good SEO". */
const ATTACH = /\s*\b(?:that|which|who|with)\s+$/i;
/** What may follow a removed attached clause: the end, a comma, or a term ("by Friday", "due ..."). */
const AFTER_ATTACHED = /^\s*(?:$|[,;:]|(?:by|due|before|within|in|on|for|at|from|until|no\s+later)\b)/i;
const ARTICLE_END = /\b(a|an|the|my|our|your|their)\s+$/i;

/** Indexes of the ", " separators not inside quotes or brackets. */
function topLevelCommas(s: string): number[] {
  const out: number[] = [];
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === "“") quoted = true;
    else if (ch === "”") quoted = false;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "," && !quoted && depth === 0 && s[i + 1] === " ") out.push(i);
  }
  return out;
}

/** Where the list holding the end of `before` starts, or -1 when no list start is found. */
function listStart(before: string): number {
  let at = -1;
  for (const m of before.matchAll(LIST_START)) at = m.index + m[0].length;
  return at;
}

/** A clause with its own subject and verb: "the code must be clean", "CI must be green". */
const CLAUSE = /^(?:the\s+)?[\w'-]+\s+(?:must|should|shall|will|has\s+to|have\s+to|needs?\s+to)\b/i;
const HAS_MODAL = /\b(?:must|should|shall|will|has\s+to|have\s+to|needs?\s+to)\b/i;

/**
 * After the last item was removed from "a, b, and c": the new last item gets
 * the conjunction ("a and b", or "a, b, and c" from four items). Items are
 * predicates after one lead-in ("It must load, work on phones, and ..."), or,
 * when the removed item was a clause, clauses ("The PR must be merged, CI
 * must be green, and ...").
 */
function relinkLastItem(before: string, oxford: boolean, clauses: boolean): string {
  const start = clauses ? 0 : listStart(before);
  if (start < 0) return before;
  const commas = topLevelCommas(before.slice(start)).map((i) => i + start);
  if (commas.length === 0) return before;
  const last = commas[commas.length - 1];
  if (clauses && !HAS_MODAL.test(before.slice(last))) return before;
  const joint = commas.length === 1 || !oxford ? " and " : ", and ";
  return `${before.slice(0, last)}${joint}${before.slice(last + 2)}`;
}

/**
 * The sentence with the phrase at [i, i + n) taken out: "" to drop the whole
 * sentence, or null when the phrase cannot be cut out and leave good prose.
 */
function withoutPhrase(sentence: string, i: number, n: number): string | null {
  const close = /[.!?]+["”')]*\s*$/.exec(sentence);
  const bodyEnd = close ? close.index : sentence.length;
  const punct = close ? close[0].trim() : ".";
  let before = sentence.slice(0, i);
  let after = sentence.slice(Math.min(i + n, bodyEnd), bodyEnd);

  // "professional and modern": a lone word joined to the phrase belongs to it.
  const tail = /^\s+and\s+[\w-]+(?=\s*(?:$|,))/i.exec(after);
  if (tail && !/\s+(?:and|or)\s+$/i.test(before)) after = after.slice(tail[0].length);

  // The phrase is the whole sentence apart from its lead-in: "It must also look professional."
  if (!after.trim() && LEAD_IN.test(before)) return "";

  // Last item of a list or a clause after "and": "a, b, and <phrase>", "<clause>, and <phrase>".
  const lastSep = SEP_BEFORE_LAST.exec(before);
  if (!after.trim() && lastSep) {
    const clause = CLAUSE.test(sentence.slice(i, i + n));
    return relinkLastItem(before.slice(0, lastSep.index), lastSep[1] === ",", clause).trimEnd() + punct;
  }
  // A lone word joined by "and" before more of the sentence: "look professional and <modern>, and ...".
  if (lastSep && /^\s*,/.test(after)) {
    return before.slice(0, lastSep.index) + after + punct;
  }
  // Last item with no conjunction: "a, b, <phrase>".
  if (!after.trim() && /,\s*$/.test(before) && listStart(before) >= 0) {
    return before.replace(/,\s*$/, "") + punct;
  }

  const sepAfter = SEP_AFTER.exec(after);
  // A middle item: "a, <phrase>, and c" or "a, <phrase>, c".
  if (/,\s*$/.test(before) && sepAfter && listStart(before) >= 0) {
    before = before.replace(/,\s*$/, "");
    const start = listStart(before);
    if (/^\s*,\s*(?:and|or)\s+/i.test(after) && start >= 0 && topLevelCommas(before.slice(start)).length === 0) {
      after = after.replace(/^\s*,\s*/, " ");
    }
    return before + after + punct;
  }

  // The first item: "<phrase>, and b", "It must <phrase> and b". What is left must be a list
  // (a conjunction follows) of more than one word, not a term such as ", due Friday".
  const opensList = !before.trim() || LEAD_IN.test(before) || /\b(?:that|which|to)\s+$/i.test(before);
  const rest0 = sepAfter ? after.slice(sepAfter[0].length) : "";
  const isList = sepAfter !== null && (/\b(?:and|or)\b/i.test(sepAfter[0]) || /(?:,|\s)\s*(?:and|or)\s/i.test(rest0));
  if (opensList && isList && /\S+\s+\S+/.test(rest0)) {
    let rest = rest0;
    const commas = topLevelCommas(rest);
    if (commas.length === 1 && /^,\s*(?:and|or)\s+/i.test(rest.slice(commas[0]))) {
      rest = rest.slice(0, commas[0]) + rest.slice(commas[0] + 1);
    }
    // A clause left after a bare lead-in ("It must <phrase>, and the code must be clean") stands alone.
    if (!before.trim() || (LEAD_IN.test(before) && CLAUSE.test(rest))) return rest.charAt(0).toUpperCase() + rest.slice(1) + punct;
    return before + rest + punct;
  }

  // A clause or phrase attached to a noun: "a site that <phrase>, due Friday", "a site with <phrase>".
  if (ATTACH.test(before) && AFTER_ATTACHED.test(after)) {
    return before.replace(ATTACH, "") + after + punct;
  }

  // An adjective: "a <fast> website" -> "a website", "a <high-quality> online store" -> "an online store".
  const article = ARTICLE_END.exec(before);
  if (article && /^\s+[a-z]/i.test(after) && phraseWords(sentence.slice(i, i + n)) <= 4) {
    const rest = after.trimStart();
    let lead = before;
    if (/^an?$/i.test(article[1])) {
      const an = /^[aeiou]/i.test(rest) ? "an" : "a";
      const cased = article[1][0] === "A" ? an.charAt(0).toUpperCase() + an.slice(1) : an;
      lead = before.slice(0, article.index) + cased + " ";
    }
    return lead + rest + punct;
  }

  return null;
}

function phraseWords(phrase: string): number {
  return phrase.trim().split(/\s+/).length;
}
