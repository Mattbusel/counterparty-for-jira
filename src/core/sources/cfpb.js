// CFPB Consumer Complaint Database: for financial-services counterparties (payments, lending,
// collections, banking), how many consumers complained in the last 24 months and how they were handled.
import { tokens, scoreNames } from '../normalize.js';

export const CFPB_HOSTS = ['www.consumerfinance.gov'];
const API = 'https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/';

export async function screenCfpb(query, ctx) {
  const base = { source: 'cfpb', label: 'Consumer complaints (CFPB)', sourceUrl: 'https://www.consumerfinance.gov/data-research/consumer-complaints/' };
  const now = new Date(ctx.now || Date.now());
  const since = new Date(now.getTime() - 730 * 86400e3).toISOString().slice(0, 10);
  const url = `${API}?search_term=${encodeURIComponent(`"${query}"`)}&field=company&size=0&date_received_min=${since}`;
  const res = await ctx.fetch(url, { headers: { 'User-Agent': ctx.userAgent, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`CFPB HTTP ${res.status}`);
  const d = await res.json();
  const buckets = (((d.aggregations || {}).company || {}).company || {}).buckets || [];
  const qt = tokens(query);
  const mine = buckets.filter(b => scoreNames(qt, tokens(b.key)).score >= 0.8);
  if (!mine.length) {
    return { ...base, status: 'info', severity: 'info', headline: 'No consumer complaints filed against this name in 24 months', findings: [], asOf: `since ${since}` };
  }
  const count = mine.reduce((s, b) => s + b.doc_count, 0);
  const timely = (((d.aggregations || {}).timely || {}).timely || {}).buckets || [];
  const late = (timely.find(b => b.key === 'No') || {}).doc_count || 0;
  const products = ((((d.aggregations || {}).product || {}).product || {}).buckets || []).slice(0, 3).map(b => `${b.key} (${b.doc_count})`);
  const lateShare = count ? late / count : 0;
  const severity = lateShare > 0.05 && count >= 50 ? 'review' : 'info';
  const findings = mine.slice(0, 3).map(b => ({
    title: `${b.key}: ${b.doc_count.toLocaleString('en-US')} complaints since ${since}`,
    detail: products.length ? `top products: ${products.join(', ')}` : '',
    url: `https://www.consumerfinance.gov/data-research/consumer-complaints/search/?company=${encodeURIComponent(b.key)}&date_received_min=${since}`,
  }));
  if (severity === 'review') {
    findings.push({ title: 'Slow complaint handling', detail: `${(lateShare * 100).toFixed(1)}% of complaints were not answered on time`, url: findings[0].url, flag: true });
  }
  return {
    ...base, status: severity === 'review' ? 'flag' : 'info', severity,
    headline: `${count.toLocaleString('en-US')} consumer complaints in 24 months${late ? `, ${late} answered late` : ''}`,
    findings, asOf: `since ${since}`,
  };
}
