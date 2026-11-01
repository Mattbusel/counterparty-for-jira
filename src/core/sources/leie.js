// HHS Office of Inspector General List of Excluded Individuals/Entities (LEIE).
// Anyone billing Medicare or Medicaid must not pay an excluded party; this is the official file.
import { parseCsv } from '../csv.js';
import { NameIndex } from '../normalize.js';
import { cached } from '../cache.js';

export const LEIE_URL = 'https://oig.hhs.gov/exclusions/downloadables/UPDATED.csv';
export const LEIE_HOSTS = ['oig.hhs.gov'];

// Plain-language meaning of the most common exclusion authorities (Social Security Act sections).
const AUTHORITY = {
  '1128a1': 'conviction of a program-related crime',
  '1128a2': 'conviction relating to patient abuse or neglect',
  '1128a3': 'felony conviction relating to health care fraud',
  '1128a4': 'felony conviction relating to controlled substances',
  '1128b1': 'misdemeanor conviction relating to health care fraud',
  '1128b4': 'license revocation or suspension',
  '1128b5': 'exclusion or suspension under a federal or state health care program',
  '1128b7': 'fraud, kickbacks, or other prohibited activities',
  '1128b8': 'entity controlled by a sanctioned individual',
  '1128b14': 'default on health education loan or scholarship obligations',
  '1128Aa': 'civil monetary penalty',
};

const fmtDate = d => (d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '');

export function loadLeie(ctx) {
  return cached('leie-index', 6 * 3600e3, async () => {
    const res = await ctx.fetch(LEIE_URL, { headers: { 'User-Agent': ctx.userAgent } });
    if (!res.ok) throw new Error(`LEIE HTTP ${res.status}`);
    const rows = parseCsv(await res.text());
    const head = rows.shift() || [];
    const col = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
    const index = new NameIndex();
    let n = 0;
    for (const r of rows) {
      if (r.length < head.length - 1) continue;
      const bus = (r[col.BUSNAME] || '').trim();
      const person = [r[col.FIRSTNAME], r[col.MIDNAME], r[col.LASTNAME]].map(s => (s || '').trim()).filter(Boolean).join(' ');
      const rec = {
        uid: n++,
        name: bus || person,
        kind: bus ? 'entity' : 'individual',
        general: (r[col.GENERAL] || '').trim(),
        specialty: (r[col.SPECIALTY] || '').trim(),
        city: (r[col.CITY] || '').trim(), state: (r[col.STATE] || '').trim(),
        npi: (r[col.NPI] || '').trim(),
        type: (r[col.EXCLTYPE] || '').trim(),
        excluded: fmtDate((r[col.EXCLDATE] || '').trim()),
        waiver: (r[col.WAIVERDATE] || '').trim() !== '0' ? fmtDate((r[col.WAIVERDATE] || '').trim()) : '',
      };
      index.add(rec.name, rec);
    }
    const lm = res.headers && res.headers.get && res.headers.get('last-modified');
    return { index, count: n, published: lm ? new Date(lm).toISOString().slice(0, 10) : null };
  });
}

export async function screenLeie(query, ctx) {
  const { index, count, published } = await loadLeie(ctx);
  const hits = index.search(query, { minScore: 0.8, limit: 5 });
  const findings = hits.map(h => {
    const r = h.record;
    return {
      title: `${r.name} (${r.kind}${r.city ? `, ${r.city} ${r.state}` : ''})`,
      detail: [
        `excluded ${r.excluded}`,
        AUTHORITY[r.type] ? `${r.type}: ${AUTHORITY[r.type]}` : r.type,
        [r.general, r.specialty].filter(Boolean).join(' / '),
        r.npi && r.npi !== '0' ? `NPI ${r.npi}` : '',
        r.waiver ? `waiver granted ${r.waiver}` : '',
      ].filter(Boolean).join(' | '),
      url: 'https://exclusions.oig.hhs.gov/',
      score: h.score,
      strong: h.score >= 0.92 && !r.waiver,
    };
  });
  const strong = findings.some(f => f.strong);
  return {
    source: 'leie', label: 'HHS-OIG exclusions (LEIE)',
    status: strong ? 'match' : findings.length ? 'possible' : 'clear',
    severity: strong ? 'block' : findings.length ? 'review' : 'none',
    headline: strong
      ? 'Name matches a party excluded from Medicare and Medicaid'
      : findings.length
        ? `${findings.length} possible exclusion match${findings.length > 1 ? 'es' : ''} to review`
        : `No match among ${count.toLocaleString('en-US')} excluded individuals and entities`,
    findings,
    asOf: published ? `file updated ${published}` : 'current file',
    sourceUrl: 'https://oig.hhs.gov/exclusions/',
  };
}
