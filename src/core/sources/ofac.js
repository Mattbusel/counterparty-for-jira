// U.S. Treasury OFAC sanctions lists: the SDN list plus the Consolidated (non-SDN) lists,
// with every alias ("a.k.a.") indexed against its listed party.
import { parseCsv, ofacCell } from '../csv.js';
import { NameIndex } from '../normalize.js';
import { cached } from '../cache.js';

const BASE = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/';
export const OFAC_HOSTS = ['sanctionslistservice.ofac.treas.gov', 'wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com'];

async function getText(ctx, file) {
  const res = await ctx.fetch(BASE + file, { headers: { 'User-Agent': ctx.userAgent } });
  if (!res.ok) throw new Error(`OFAC ${file} HTTP ${res.status}`);
  const text = await res.text();
  // The export redirects to a dated S3 path (".../2026-10-27/..."): that date is the list version.
  const m = String(res.url || '').match(/\/(\d{4}-\d{2}-\d{2})\//);
  const lm = res.headers && res.headers.get && res.headers.get('last-modified');
  const lmDate = lm && !Number.isNaN(Date.parse(lm)) ? new Date(lm).toISOString().slice(0, 10) : null;
  return { text, published: m ? m[1] : lmDate };
}

/** Download and index the four OFAC files. Cached per warm runtime for 6 hours. */
export function loadOfac(ctx) {
  return cached('ofac-index', 6 * 3600e3, async () => {
    const [sdn, alt, cons, consAlt] = await Promise.all(
      ['SDN.CSV', 'ALT.CSV', 'CONS_PRIM.CSV', 'CONS_ALT.CSV'].map(f => getText(ctx, f)),
    );
    const index = new NameIndex();
    const parties = new Map();
    const addPrimary = (rows, list) => {
      for (const r of rows) {
        if (r.length < 4 || !/^\d+$/.test(r[0].trim())) continue;
        const uid = `${list}:${r[0].trim()}`;
        const party = {
          uid, list, entNum: r[0].trim(), name: ofacCell(r[1]),
          type: ofacCell(r[2]) || 'entity', programs: ofacCell(r[3]).replace(/\] \[/g, ', '),
          remarks: ofacCell(r[11]).slice(0, 400),
        };
        parties.set(uid, party);
        index.add(party.name, party);
      }
    };
    const addAliases = (rows, list) => {
      for (const r of rows) {
        if (r.length < 4 || !/^\d+$/.test(r[0].trim())) continue;
        const party = parties.get(`${list}:${r[0].trim()}`);
        if (party) index.add(ofacCell(r[3]), party);
      }
    };
    addPrimary(parseCsv(sdn.text), 'SDN');
    addPrimary(parseCsv(cons.text), 'CONS');
    addAliases(parseCsv(alt.text), 'SDN');
    addAliases(parseCsv(consAlt.text), 'CONS');
    return { index, parties: parties.size, published: sdn.published || cons.published };
  });
}

export function ofacUrl(party) {
  return `https://sanctionssearch.ofac.treas.gov/Details.aspx?id=${party.entNum}`;
}

/** Screen a name. Strong match >= 0.92 blocks; 0.8 to 0.92 needs a human look. */
export async function screenOfac(query, ctx, { label = 'OFAC sanctions' } = {}) {
  const { index, parties, published } = await loadOfac(ctx);
  // The same party often sits on both the SDN and a consolidated list; show it once.
  const seen = new Set();
  const hits = index.search(query, { minScore: 0.8, limit: 10 })
    .filter(h => !seen.has(h.record.name) && seen.add(h.record.name)).slice(0, 5);
  const findings = hits.map(h => ({
    title: h.record.name + (h.name !== h.record.name ? ` (matched alias "${h.name}")` : ''),
    detail: [
      h.record.list === 'SDN' ? 'Specially Designated Nationals list' : 'Consolidated non-SDN list',
      h.record.type, h.record.programs && `programs: ${h.record.programs}`, h.record.remarks,
    ].filter(Boolean).join(' | '),
    url: ofacUrl(h.record),
    score: h.score,
    strong: h.score >= 0.92,
  }));
  const strong = findings.some(f => f.strong);
  return {
    source: 'ofac', label,
    status: strong ? 'match' : findings.length ? 'possible' : 'clear',
    severity: strong ? 'block' : findings.length ? 'review' : 'none',
    headline: strong
      ? `Name matches a sanctioned party (${Math.round(findings[0].score * 100)}% match)`
      : findings.length
        ? `${findings.length} possible match${findings.length > 1 ? 'es' : ''} to review`
        : `No match among ${parties.toLocaleString('en-US')} sanctioned parties and their aliases`,
    findings,
    asOf: published ? `list published ${published}` : 'live list',
    sourceUrl: 'https://sanctionssearch.ofac.treas.gov/',
  };
}
