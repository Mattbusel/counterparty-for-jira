// SEC EDGAR: for counterparties that file with the SEC, read their own disclosures for
// distress and control events (bankruptcy, restatements, auditor changes, late filings).
import { tokens, scoreNames, NameIndex } from '../normalize.js';
import { cached } from '../cache.js';

export const SEC_HOSTS = ['efts.sec.gov', 'data.sec.gov', 'www.sec.gov'];

// 8-K items that change a counterparty's risk, with plain-language meaning.
export const RED_ITEMS = {
  '1.03': { sev: 'review', text: 'Bankruptcy or receivership' },
  '2.04': { sev: 'review', text: 'Event that accelerates a debt obligation' },
  '3.01': { sev: 'info', text: 'Delisting notice, listing-standard failure, or transfer of listing' },
  '4.01': { sev: 'info', text: 'Change of certifying accountant' },
  '4.02': { sev: 'review', text: 'Previously issued financial statements should no longer be relied on' },
};
const LATE_FORMS = { 'NT 10-K': 'Late annual report notice', 'NT 10-Q': 'Late quarterly report notice', 'NT 20-F': 'Late annual report notice (foreign issuer)' };
const DEREG_FORMS = { '15-12B': 'Deregistration of securities', '15-12G': 'Deregistration of securities', '15-15D': 'Suspension of reporting duty' };

const pad = cik => String(cik).padStart(10, '0');

async function getJson(ctx, url) {
  const res = await ctx.fetch(url, { headers: { 'User-Agent': ctx.userAgent, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`SEC HTTP ${res.status}`);
  return res.json();
}

// EDGAR appends state codes to some names ("WELLS FARGO & COMPANY/MN"); drop them before matching.
const secName = n => String(n || '').replace(/\s*\/[A-Z]{2,3}\/?\s*$/, '');

/** Every exchange-listed SEC filer, indexed by name. Cached per warm runtime for 12 hours. */
function loadTickers(ctx) {
  return cached('sec-tickers', 12 * 3600e3, async () => {
    const d = await getJson(ctx, 'https://www.sec.gov/files/company_tickers.json');
    const index = new NameIndex();
    for (const k of Object.keys(d)) index.add(secName(d[k].title), { uid: d[k].cik_str, cik: d[k].cik_str, name: d[k].title });
    return index;
  });
}

/** Resolve a name to the best EDGAR filer, or null. Listed companies first, then all filers. */
export async function findFiler(query, ctx) {
  const listed = (await loadTickers(ctx)).search(query, { minScore: 0.85, limit: 1 })[0];
  if (listed) return { score: listed.score, cik: String(listed.record.cik), name: listed.record.name };
  const d = await getJson(ctx, `https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(query)}`);
  const qt = tokens(query);
  let best = null;
  for (const h of (d.hits && d.hits.hits) || []) {
    const name = h._source && h._source.entity;
    if (!name) continue;
    const s = scoreNames(qt, tokens(secName(name))).score;
    if (!best || s > best.score) best = { score: s, cik: h._id, name };
  }
  return best && best.score >= 0.85 ? best : null;
}

/** Scan a filer's recent filings and return a scored source result. */
export async function screenSec(query, ctx) {
  const base = { source: 'sec', label: 'SEC EDGAR filings', sourceUrl: 'https://www.sec.gov/edgar/search/' };
  const filer = await findFiler(query, ctx);
  if (!filer) {
    return { ...base, status: 'info', severity: 'info', headline: 'Not an SEC filer (no public-company disclosures to check)', findings: [], asOf: 'live EDGAR' };
  }
  const sub = await getJson(ctx, `https://data.sec.gov/submissions/CIK${pad(filer.cik)}.json`);
  const r = sub.filings.recent;
  const now = ctx.now ? new Date(ctx.now) : new Date();
  const cutoff = new Date(now.getTime() - 730 * 86400e3).toISOString().slice(0, 10);
  const findings = [];
  let severity = 'none';
  let lastAnnual = null;
  const docUrl = i => `https://www.sec.gov/Archives/edgar/data/${Number(filer.cik)}/${r.accessionNumber[i].replace(/-/g, '')}/${r.primaryDocument[i]}`;
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i], date = r.filingDate[i];
    if (!lastAnnual && (form === '10-K' || form === '20-F' || form === '40-F')) lastAnnual = { form, date, url: docUrl(i) };
    if (date < cutoff) continue;
    if (form === '8-K' || form === '8-K/A') {
      for (const item of String(r.items[i] || '').split(',').map(s => s.trim())) {
        const red = RED_ITEMS[item];
        if (!red) continue;
        findings.push({ title: `${date}: 8-K Item ${item}`, detail: red.text, url: docUrl(i), flag: true });
        if (red.sev === 'review') severity = 'review';
        else if (severity === 'none') severity = 'info';
      }
    } else if (LATE_FORMS[form]) {
      findings.push({ title: `${date}: ${form}`, detail: LATE_FORMS[form], url: docUrl(i), flag: true });
      severity = 'review';
    } else if (DEREG_FORMS[form]) {
      findings.push({ title: `${date}: Form ${form}`, detail: DEREG_FORMS[form], url: docUrl(i), flag: true });
      if (severity === 'none') severity = 'info';
    }
  }
  const identity = {
    title: `${sub.name} (CIK ${Number(filer.cik)})`,
    detail: [
      sub.tickers && sub.tickers.length ? `tickers ${sub.tickers.join(', ')}` : 'no listed ticker',
      sub.sicDescription, sub.stateOfIncorporation && `incorporated in ${sub.stateOfIncorporation}`,
      lastAnnual ? `last annual report ${lastAnnual.form} on ${lastAnnual.date}` : 'no annual report on file',
    ].filter(Boolean).join(' | '),
    url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${pad(filer.cik)}`,
  };
  const flagged = findings.length;
  return {
    ...base,
    status: severity === 'review' ? 'flag' : 'info',
    severity: severity === 'none' ? 'info' : severity,
    headline: severity === 'review'
      ? `${flagged} disclosure${flagged > 1 ? 's' : ''} in the last 24 months worth a look`
      : flagged
        ? `No distress filings in 24 months; ${flagged} routine notice${flagged > 1 ? 's' : ''} on file`
        : 'SEC filer with no distress filings in the last 24 months',
    findings: [identity, ...findings.slice(0, 8)],
    asOf: `filings through ${r.filingDate[0] || 'today'}`,
    matchedName: sub.name,
  };
}
