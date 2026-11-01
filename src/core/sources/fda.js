// openFDA enforcement reports: recalls by the counterparty as the recalling firm, across
// medical devices, drugs and food. Class I means a reasonable chance of serious harm or death.
import { tokens, scoreNames } from '../normalize.js';

export const FDA_HOSTS = ['api.fda.gov'];
const KINDS = [['device', 'Medical device'], ['drug', 'Drug'], ['food', 'Food']];

const isoDate = s => (s && s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s || '');

export async function screenFda(query, ctx) {
  const base = { source: 'fda', label: 'FDA recalls (openFDA)', sourceUrl: 'https://www.accessdata.fda.gov/scripts/ires/' };
  const now = new Date(ctx.now || Date.now());
  const since = new Date(now.getTime() - 730 * 86400e3).toISOString().slice(0, 10).replace(/-/g, '');
  const until = now.toISOString().slice(0, 10).replace(/-/g, '');
  const qt = tokens(query);
  // Search on the identity words so "Acme Medical, Inc." finds "ACME MEDICAL INC".
  const term = qt.map(t => `recalling_firm:${t}`).join('+AND+');
  let lastUpdated = '';
  let capped = false;
  const results = await Promise.all(KINDS.map(async ([kind, label]) => {
    const url = `https://api.fda.gov/${kind}/enforcement.json?search=${term}+AND+report_date:[${since}+TO+${until}]&limit=100`;
    const res = await ctx.fetch(url, { headers: { 'User-Agent': ctx.userAgent } });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`openFDA ${kind} HTTP ${res.status}`);
    const d = await res.json();
    lastUpdated = (d.meta && d.meta.last_updated) || lastUpdated;
    if (d.meta && d.meta.results && d.meta.results.total > 100) capped = true;
    return (d.results || [])
      .filter(r => scoreNames(qt, tokens(r.recalling_firm)).score >= 0.85)
      .map(r => ({ ...r, kind, kindLabel: label }));
  }));
  const recalls = results.flat();
  if (!recalls.length) {
    return { ...base, status: 'info', severity: 'info', headline: 'No FDA recalls by this firm in 24 months', findings: [], asOf: lastUpdated ? `data through ${lastUpdated}` : 'live data' };
  }
  const classI = recalls.filter(r => r.classification === 'Class I');
  recalls.sort((a, b) => (a.classification === 'Class I' ? -1 : 0) - (b.classification === 'Class I' ? -1 : 0) || String(b.report_date).localeCompare(String(a.report_date)));
  const findings = recalls.slice(0, 5).map(r => ({
    title: `${isoDate(r.report_date)}: ${r.classification} ${r.kindLabel.toLowerCase()} recall (${r.recall_number})`,
    detail: `${r.recalling_firm}: ${String(r.product_description || '').slice(0, 160)}${r.reason_for_recall ? ` | reason: ${String(r.reason_for_recall).slice(0, 160)}` : ''} | status ${r.status}`,
    url: `https://api.fda.gov/${r.kind}/enforcement.json?search=recall_number:"${encodeURIComponent(r.recall_number)}"`,
    flag: r.classification === 'Class I',
  }));
  return {
    ...base,
    status: classI.length ? 'flag' : 'info',
    severity: classI.length ? 'review' : 'info',
    headline: `${recalls.length}${capped ? '+' : ''} recall${recalls.length > 1 ? 's' : ''} in 24 months${classI.length ? `, ${classI.length} Class I (most serious)` : ''}`,
    findings, asOf: lastUpdated ? `data through ${lastUpdated}` : 'live data',
  };
}
