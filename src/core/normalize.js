// Name normalization and fuzzy matching used by every list screen.
// Pure functions: no Forge APIs, so they run the same in tests and in the app.

// Multi-word legal forms are removed before tokenizing so that
// "PUBLIC JOINT STOCK COMPANY SBERBANK" and "Sberbank PJSC" compare on "SBERBANK".
const LEGAL_PHRASES = [
  'PUBLIC JOINT STOCK COMPANY', 'CLOSED JOINT STOCK COMPANY', 'OPEN JOINT STOCK COMPANY',
  'JOINT STOCK COMPANY', 'LIMITED LIABILITY COMPANY', 'LIMITED LIABILITY PARTNERSHIP',
  'LIMITED PARTNERSHIP', 'PUBLIC LIMITED COMPANY', 'PRIVATE LIMITED', 'SOCIEDAD ANONIMA',
  'SOCIETE ANONYME', 'L L C', 'L L P', 'L P', 'S A', 'N V', 'B V', 'S P A', 'S R L', 'S A S',
];

// Single tokens that describe the legal form, not the name.
const LEGAL_TOKENS = new Set([
  'INC', 'INCORPORATED', 'LLC', 'LTD', 'LIMITED', 'CO', 'CORP', 'CORPORATION', 'COMPANY',
  'PLC', 'LP', 'LLP', 'GMBH', 'AG', 'SA', 'SAS', 'SARL', 'BV', 'NV', 'SPA', 'SRL', 'OOO',
  'OAO', 'ZAO', 'PAO', 'AO', 'JSC', 'PJSC', 'OJSC', 'CJSC', 'PTE', 'PTY', 'KG', 'AB', 'AS',
  'OY', 'FZE', 'FZCO', 'FZC', 'DMCC', 'SDN', 'BHD', 'TOO', 'TOV', 'DOO', 'KFT', 'SPZOO',
  'HOLDINGS', 'HOLDING', 'GROUP', 'INTERNATIONAL', 'INTL',
]);

// Connector words that carry no identity.
const STOP_TOKENS = new Set(['THE', 'OF', 'AND', 'FOR', 'DE', 'DA', 'DO', 'DI', 'LA', 'LE', 'EL', 'Y', 'ET']);

/** Uppercase, strip accents and punctuation, collapse whitespace. */
export function clean(name) {
  return String(name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Identity tokens of a name: legal forms and connector words removed.
 * Falls back to all tokens when a name is only legal words (e.g. "Holding Co").
 */
export function tokens(name) {
  let s = ` ${clean(name)} `;
  for (const p of LEGAL_PHRASES) s = s.split(` ${p} `).join(' ');
  const all = s.trim().split(' ').filter(Boolean);
  const core = all.filter(t => !LEGAL_TOKENS.has(t) && !STOP_TOKENS.has(t));
  return core.length ? core : all;
}

/** Jaro-Winkler similarity in [0,1]. */
export function jaroWinkler(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const am = new Array(la).fill(false), bm = new Array(lb).fill(false);
  let m = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - range), hi = Math.min(i + range + 1, lb);
    for (let j = lo; j < hi; j++) {
      if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; m++; break; }
    }
  }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < la; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (m / la + m / lb + (m - t / 2) / m) / 3;
  let p = 0;
  while (p < 4 && p < la && p < lb && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

/** Similarity of two single tokens. Short tokens must match exactly. */
function tokenSim(a, b) {
  if (a === b) return 1;
  if (a.length < 4 || b.length < 4) return 0;
  const s = jaroWinkler(a, b);
  return s >= 0.92 ? s : 0;
}

/**
 * Score a query name against a listed name.
 * Returns { score, queryCoverage, listCoverage } with score in [0,1].
 * queryCoverage: how much of what we typed is found in the listed name.
 * listCoverage: how much of the listed name is explained by what we typed.
 */
export function scoreNames(queryTokens, listTokens) {
  if (!queryTokens.length || !listTokens.length) return { score: 0, queryCoverage: 0, listCoverage: 0 };
  const used = new Array(listTokens.length).fill(false);
  let matched = 0;
  for (const q of queryTokens) {
    let best = 0, bi = -1;
    for (let j = 0; j < listTokens.length; j++) {
      if (used[j]) continue;
      const s = tokenSim(q, listTokens[j]);
      if (s > best) { best = s; bi = j; }
    }
    if (bi >= 0) { used[bi] = true; matched += best; }
  }
  const queryCoverage = matched / queryTokens.length;
  const listCoverage = matched / listTokens.length;
  // Weighted toward the query: a listed name that contains every word we typed is a lead,
  // while extra unexplained words in the listed name pull the score down.
  const score = 0.6 * queryCoverage + 0.4 * listCoverage;
  return { score: Math.round(score * 1000) / 1000, queryCoverage, listCoverage };
}

/**
 * A token index over a list of records so a screen only scores records
 * that share at least one token (or a 4-letter prefix) with the query.
 */
export class NameIndex {
  constructor() { this.records = []; this.byKey = new Map(); }

  add(name, record) {
    const toks = tokens(name);
    if (!toks.length) return;
    const id = this.records.length;
    this.records.push({ name, toks, record });
    const keys = new Set();
    for (const t of toks) { keys.add('T' + t); if (t.length >= 4) keys.add('P' + t.slice(0, 4)); }
    for (const k of keys) {
      let arr = this.byKey.get(k);
      if (!arr) { arr = []; this.byKey.set(k, arr); }
      arr.push(id);
    }
  }

  get size() { return this.records.length; }

  /** Best matches for a query at or above minScore, highest first, one row per listed party. */
  search(query, { minScore = 0.8, limit = 10 } = {}) {
    const qt = tokens(query);
    if (!qt.length) return [];
    const cand = new Set();
    for (const t of qt) {
      for (const id of this.byKey.get('T' + t) || []) cand.add(id);
      if (t.length >= 4) for (const id of this.byKey.get('P' + t.slice(0, 4)) || []) cand.add(id);
    }
    const out = [];
    for (const id of cand) {
      const r = this.records[id];
      const s = scoreNames(qt, r.toks);
      if (s.score >= minScore) out.push({ ...s, name: r.name, record: r.record });
    }
    out.sort((a, b) => b.score - a.score);
    const seen = new Set(), dedup = [];
    for (const o of out) {
      const key = o.record && o.record.uid !== undefined ? o.record.uid : o.name;
      if (seen.has(key)) continue;
      seen.add(key); dedup.push(o);
      if (dedup.length >= limit) break;
    }
    return dedup;
  }
}
