// Orchestrates one counterparty screen: runs every public source in parallel, joins them
// (registry identity and ownership feed back into the sanctions screen), and returns a verdict
// with a receipt: every source, its data version, and the evidence links behind each finding.
import { createHash } from 'node:crypto';
import { screenOfac, OFAC_HOSTS } from './sources/ofac.js';
import { screenLeie, LEIE_HOSTS } from './sources/leie.js';
import { lookupGleif, gleifResult, GLEIF_HOSTS } from './sources/gleif.js';
import { screenSec, SEC_HOSTS } from './sources/sec.js';
import { screenUsaspending, USASPENDING_HOSTS } from './sources/usaspending.js';
import { screenCfpb, CFPB_HOSTS } from './sources/cfpb.js';
import { screenFda, FDA_HOSTS } from './sources/fda.js';
import { tokens, scoreNames } from './normalize.js';

export const ALL_HOSTS = [...OFAC_HOSTS, ...LEIE_HOSTS, ...GLEIF_HOSTS, ...SEC_HOSTS, ...USASPENDING_HOSTS, ...CFPB_HOSTS, ...FDA_HOSTS];
export const USER_AGENT = 'Counterparty-for-Jira/1.0 (Tensorust LLC; mattbusel@tensorust.com)';

// Sources whose failure means we cannot call a counterparty clear.
const REQUIRED = new Set(['ofac', 'leie']);
const ORDER = ['ofac', 'leie', 'gleif', 'sec', 'usaspending', 'fda', 'cfpb'];
const LABELS = {
  ofac: 'OFAC sanctions', leie: 'HHS-OIG exclusions (LEIE)', gleif: 'Legal entity registry (GLEIF)',
  sec: 'SEC EDGAR filings', usaspending: 'Federal contracts (USAspending)', cfpb: 'Consumer complaints (CFPB)', fda: 'FDA recalls (openFDA)',
};

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

function failed(source, err) {
  return {
    source, label: LABELS[source], status: 'error', severity: REQUIRED.has(source) ? 'review' : 'info',
    headline: `Could not complete: ${String(err && err.message ? err.message : err).slice(0, 160)}`,
    findings: [], asOf: 'n/a',
  };
}

const safe = (source, fn, ms) => withTimeout(Promise.resolve().then(fn), ms, LABELS[source]).catch(e => failed(source, e));

/** Pick the verdict and the reasons a reviewer needs to read first. */
export function decide(sources) {
  const reasons = [];
  let verdict = 'CLEAR';
  for (const s of sources) {
    if (s.severity === 'block') {
      verdict = 'BLOCK';
      reasons.push(`${s.label}: ${s.headline}`);
    }
  }
  for (const s of sources) {
    if (s.severity === 'review') {
      if (verdict !== 'BLOCK') verdict = 'REVIEW';
      reasons.push(`${s.label}: ${s.headline}`);
    }
  }
  if (verdict === 'CLEAR') reasons.push('No sanctions, exclusion or distress findings across every source checked.');
  return { verdict, reasons };
}

/** Short stable hash of what was found, so a pasted receipt can be checked against the stored one. */
export function receiptId(report) {
  const canon = JSON.stringify({
    q: report.query, v: report.verdict, at: report.checkedAt,
    s: report.sources.map(s => [s.source, s.status, s.asOf, s.findings.map(f => f.title)]),
  });
  return createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

/**
 * Screen one counterparty.
 * @param {string} name   company or person name as the requester typed it
 * @param {object} deps   { fetch, now? } fetch is @forge/api fetch in the app, global fetch in tests
 */
export async function screenCounterparty(name, deps) {
  const query = String(name || '').trim().slice(0, 200);
  if (tokens(query).length === 0) throw new Error('Enter a company or person name to screen.');
  const ctx = { fetch: deps.fetch, now: deps.now || Date.now(), userAgent: USER_AGENT };
  const started = Date.now();

  const gleifLookup = withTimeout(lookupGleif(query, ctx), 20000, 'GLEIF').catch(e => ({ error: e }));
  const [ofac, leie, sec, usa, cfpb, fda, gl] = await Promise.all([
    safe('ofac', () => screenOfac(query, ctx), 40000),
    safe('leie', () => screenLeie(query, ctx), 40000),
    safe('sec', () => screenSec(query, ctx), 20000),
    safe('usaspending', () => screenUsaspending(query, ctx), 20000),
    safe('cfpb', () => screenCfpb(query, ctx), 15000),
    safe('fda', () => screenFda(query, ctx), 15000),
    gleifLookup,
  ]);

  // Join 1: screen the registered legal name and every parent company against sanctions lists.
  let gleif;
  const extraOfac = [];
  if (gl && gl.error) {
    gleif = failed('gleif', gl.error);
  } else {
    const parentScreens = [];
    if (gl) {
      const qt = tokens(query);
      const names = [];
      if (gl.entity && scoreNames(qt, tokens(gl.entity.name)).score < 0.999) names.push(['legal name', gl.entity.name]);
      for (const p of [gl.directParent, gl.ultimateParent]) {
        if (p && p.lei !== gl.entity.lei && !names.some(n => n[1] === p.name)) names.push(['parent', p.name]);
      }
      for (const [role, n] of names) {
        const r = await safe('ofac', () => screenOfac(n, ctx), 20000);
        if (role === 'parent') parentScreens.push({ ...r, parentName: n });
        else extraOfac.push({ ...r, alsoScreened: n });
      }
    }
    gleif = gleifResult(gl, parentScreens);
  }
  // A sanctions hit on the registered legal name counts as a sanctions hit on the counterparty.
  for (const x of extraOfac) {
    if (x.findings.length) {
      ofac.findings = [...ofac.findings, ...x.findings.filter(f => !ofac.findings.some(o => o.url === f.url))].slice(0, 6);
      const rank = { none: 0, info: 1, review: 2, block: 3 };
      if (rank[x.severity] > rank[ofac.severity]) {
        ofac.severity = x.severity; ofac.status = x.status;
        ofac.headline = `Registered legal name "${x.alsoScreened}": ${x.headline}`;
      }
    }
    ofac.alsoScreened = [...(ofac.alsoScreened || []), x.alsoScreened];
  }

  const sources = [ofac, leie, gleif, sec, usa, fda, cfpb].sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source));
  const { verdict, reasons } = decide(sources);
  const report = {
    query,
    identity: (gl && !gl.error && gl.entity) ? { name: gl.entity.name, lei: gl.entity.lei, jurisdiction: gl.entity.jurisdiction } : null,
    verdict, reasons,
    sources,
    checkedAt: new Date(ctx.now).toISOString(),
    tookMs: Date.now() - started,
  };
  report.receiptId = receiptId(report);
  return report;
}
