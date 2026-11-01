// USAspending.gov: has the U.S. government already paid this counterparty, how much, and for what.
// A federal track record is a positive identity signal, and the UEI ties the name to SAM.gov.
import { tokens, scoreNames } from '../normalize.js';

export const USASPENDING_HOSTS = ['api.usaspending.gov'];
const API = 'https://api.usaspending.gov/api/v2';

function fyWindow(now) {
  // Five most recent federal fiscal years (Oct 1 to Sep 30).
  const d = new Date(now);
  const fy = d.getUTCMonth() >= 9 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
  return { start: `${fy - 5}-10-01`, end: `${fy}-09-30` };
}

const money = n => '$' + (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n).toLocaleString('en-US'));

async function post(ctx, path, body) {
  const res = await ctx.fetch(`${API}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ctx.userAgent }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`USAspending HTTP ${res.status}`);
  return res.json();
}

export async function screenUsaspending(query, ctx) {
  const base = { source: 'usaspending', label: 'Federal contracts (USAspending)', sourceUrl: 'https://www.usaspending.gov/search' };
  const { start, end } = fyWindow(ctx.now || Date.now());
  const filters = { recipient_search_text: [query], award_type_codes: ['A', 'B', 'C', 'D'], time_period: [{ start_date: start, end_date: end }] };
  const [cat, awards] = await Promise.all([
    post(ctx, '/search/spending_by_category/recipient/', { filters, limit: 10 }),
    post(ctx, '/search/spending_by_award/', {
      filters, limit: 25, sort: 'Award Amount', order: 'desc',
      fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Start Date', 'generated_internal_id', 'Recipient UEI'],
    }),
  ]);
  const qt = tokens(query);
  const fits = name => scoreNames(qt, tokens(name)).score >= 0.8;
  const recips = (cat.results || []).filter(r => r.name && fits(r.name));
  if (!recips.length) {
    return { ...base, status: 'info', severity: 'info', headline: `No federal contract awards found since ${start}`, findings: [], asOf: `FY${start.slice(0, 4) * 1 + 1}-FY${end.slice(0, 4)}` };
  }
  const total = recips.reduce((s, r) => s + (r.amount || 0), 0);
  const findings = recips.slice(0, 3).map(r => ({
    title: `${r.name}${r.uei ? ` (UEI ${r.uei})` : ''}`,
    detail: `${money(r.amount || 0)} in federal contract obligations`,
    url: r.recipient_id ? `https://www.usaspending.gov/recipient/${r.recipient_id}/latest` : base.sourceUrl,
  }));
  for (const a of (awards.results || []).filter(a => fits(a['Recipient Name'])).slice(0, 3)) {
    findings.push({
      title: `Award ${a['Award ID']}: ${money(a['Award Amount'] || 0)}`,
      detail: `${a['Awarding Agency']}, started ${a['Start Date']}`,
      url: `https://www.usaspending.gov/award/${a.generated_internal_id}`,
    });
  }
  return {
    ...base, status: 'info', severity: 'info',
    headline: `${money(total)} in federal contracts across ${recips.length} recipient record${recips.length > 1 ? 's' : ''} since ${start}`,
    findings, asOf: `FY${Number(start.slice(0, 4)) + 1} to FY${end.slice(0, 4)}`,
    matchedName: recips[0].name, uei: recips[0].uei || null,
  };
}
