// GLEIF Legal Entity Identifier registry: who the counterparty legally is, where it is
// registered, whether its registration is current, and who owns it (direct and ultimate parent).
import { tokens, scoreNames } from '../normalize.js';

export const GLEIF_HOSTS = ['api.gleif.org'];
const API = 'https://api.gleif.org/api/v1';

// Countries under comprehensive U.S. embargo, and others treated as high risk for ownership.
export const EMBARGOED = { CU: 'Cuba', IR: 'Iran', KP: 'North Korea', SY: 'Syria' };
export const HIGH_RISK = { RU: 'Russia', BY: 'Belarus', VE: 'Venezuela', MM: 'Myanmar' };

function summarize(rec) {
  const a = rec.attributes, e = a.entity;
  return {
    lei: a.lei,
    name: latinName(e),
    entityStatus: e.status,
    registrationStatus: a.registration && a.registration.status,
    jurisdiction: e.jurisdiction,
    country: e.legalAddress && e.legalAddress.country,
    city: e.legalAddress && e.legalAddress.city,
    created: e.creationDate ? e.creationDate.slice(0, 10) : '',
    nextRenewal: a.registration && a.registration.nextRenewalDate ? a.registration.nextRenewalDate.slice(0, 10) : '',
    url: `https://search.gleif.org/#/record/${a.lei}`,
  };
}

async function getJson(ctx, url) {
  const res = await ctx.fetch(url, { headers: { Accept: 'application/vnd.api+json', 'User-Agent': ctx.userAgent } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GLEIF HTTP ${res.status}`);
  return res.json();
}

/** Latin-script display name: some registrations (e.g. Russian issuers) file a Cyrillic legal name. */
function latinName(e) {
  const legal = e.legalName && e.legalName.name;
  if (/[A-Za-z]/.test(legal || '')) return legal;
  const alt = [...(e.otherNames || []), ...(e.transliteratedOtherNames || [])].find(n => /[A-Za-z]/.test(n.name || ''));
  return alt ? alt.name : legal;
}

/** Pick the best record among exact-name registrations: active and current first. */
function bestRecord(records) {
  // Many groups register the same legal name in several countries. The sources this app joins
  // (OFAC, SEC, USAspending, FDA, CFPB) are U.S. records, so a U.S. registration wins a tie.
  const rank = r => (r.attributes.entity.status === 'ACTIVE' ? 2 : 0) + (r.attributes.registration.status === 'ISSUED' ? 1 : 0)
    + (/^US/.test(r.attributes.entity.jurisdiction || '') ? 0.5 : 0);
  return [...records].sort((a, b) => rank(b) - rank(a))[0];
}

/** Find the best-matching legal entity and its parents. Returns null when nothing fits. */
export async function lookupGleif(query, ctx) {
  const q = encodeURIComponent(query);
  const qt = tokens(query);
  // 1) Fuzzy name completion gives the registered spelling; 2) exact-name lookup gets the record.
  const fuzzy = await getJson(ctx, `${API}/fuzzycompletions?field=entity.legalName&q=${q}`);
  let bestName = null;
  for (const c of (fuzzy && fuzzy.data) || []) {
    const s = scoreNames(qt, tokens(c.attributes.value)).score;
    if (!bestName || s > bestName.score) bestName = { score: s, name: c.attributes.value };
  }
  let rec = null, score = 0, meta = null;
  if (bestName && bestName.score >= 0.85) {
    const exact = await getJson(ctx, `${API}/lei-records?filter%5Bentity.legalName%5D=${encodeURIComponent(bestName.name)}&page%5Bsize%5D=10`);
    // The exact-name filter also matches former names, so re-check what comes back.
    const fit = ((exact && exact.data) || []).filter(r => scoreNames(qt, tokens(latinName(r.attributes.entity))).score >= 0.85);
    if (fit.length) { rec = bestRecord(fit); score = bestName.score; meta = exact.meta; }
  }
  if (!rec) {
    const data = await getJson(ctx, `${API}/lei-records?filter%5Bfulltext%5D=${q}&page%5Bsize%5D=10`);
    meta = data && data.meta;
    for (const r of (data && data.data) || []) {
      const s = scoreNames(qt, tokens(latinName(r.attributes.entity))).score + (r.attributes.entity.status === 'ACTIVE' ? 0.001 : 0);
      if (s > score) { score = s; rec = r; }
    }
    if (score < 0.85) rec = null;
  }
  if (!rec) return null;
  const entity = summarize(rec);
  const [direct, ultimate] = await Promise.all([
    getJson(ctx, `${API}/lei-records/${entity.lei}/direct-parent`),
    getJson(ctx, `${API}/lei-records/${entity.lei}/ultimate-parent`),
  ]);
  return {
    entity,
    score: Math.round(score * 1000) / 1000,
    directParent: direct && direct.data ? summarize(direct.data) : null,
    ultimateParent: ultimate && ultimate.data ? summarize(ultimate.data) : null,
    goldenCopy: meta && meta.goldenCopy && meta.goldenCopy.publishDate,
  };
}

/** Turn a lookup into a scored source result. parentScreens holds sanctions screens of parent names. */
export function gleifResult(lookup, parentScreens = []) {
  const base = { source: 'gleif', label: 'Legal entity registry (GLEIF)', sourceUrl: 'https://search.gleif.org/' };
  if (!lookup) {
    return {
      ...base, status: 'info', severity: 'info',
      headline: 'No Legal Entity Identifier found; identity not corroborated by GLEIF',
      findings: [], asOf: 'live registry',
    };
  }
  const { entity, directParent, ultimateParent } = lookup;
  const findings = [];
  let severity = 'none';
  const flag = (sev, title, detail, url) => {
    findings.push({ title, detail, url, flag: true });
    const rank = { none: 0, info: 1, review: 2 };
    if (rank[sev] > rank[severity]) severity = sev;
  };
  findings.push({
    title: `${entity.name} (LEI ${entity.lei})`,
    detail: `registered in ${entity.jurisdiction}${entity.city ? `, ${entity.city}` : ''}; entity ${entity.entityStatus}; registration ${entity.registrationStatus}${entity.created ? `; formed ${entity.created}` : ''}`,
    url: entity.url,
  });
  if (entity.entityStatus !== 'ACTIVE') flag('review', 'Entity is not active', `GLEIF lists the entity status as ${entity.entityStatus}.`, entity.url);
  if (entity.registrationStatus === 'LAPSED') flag('info', 'LEI registration has lapsed', 'The entity has not renewed its reference data, so ownership and address may be out of date.', entity.url);
  if (EMBARGOED[entity.country] || HIGH_RISK[entity.country]) {
    flag('review', `Registered in ${EMBARGOED[entity.country] || HIGH_RISK[entity.country]}`, EMBARGOED[entity.country] ? 'Comprehensively embargoed jurisdiction.' : 'High-risk jurisdiction for sanctions exposure.', entity.url);
  }
  for (const [role, p] of [['Direct parent', directParent], ['Ultimate parent', ultimateParent]]) {
    if (!p || p.lei === entity.lei) continue;
    if (role === 'Ultimate parent' && directParent && directParent.lei === p.lei) continue;
    findings.push({ title: `${role}: ${p.name}`, detail: `LEI ${p.lei}, registered in ${p.jurisdiction}`, url: p.url });
    if (EMBARGOED[p.country] || HIGH_RISK[p.country]) {
      flag('review', `${role} registered in ${EMBARGOED[p.country] || HIGH_RISK[p.country]}`, 'Ownership chain reaches a sanctions-exposed jurisdiction.', p.url);
    }
  }
  for (const ps of parentScreens) {
    if (ps.severity === 'block' || ps.severity === 'review') {
      for (const f of ps.findings) flag('review', `Owner on sanctions list: ${ps.parentName}`, `${f.title}: ${f.detail}`, f.url);
    }
  }
  return {
    ...base,
    status: severity === 'review' ? 'flag' : 'info',
    severity: severity === 'none' ? 'info' : severity,
    headline: severity === 'review'
      ? `${entity.name}: ownership or status needs review`
      : `Identified as ${entity.name}, ${entity.jurisdiction}${ultimateParent && ultimateParent.lei !== entity.lei ? `; owned by ${ultimateParent.name}` : ''}`,
    findings,
    asOf: lookup.goldenCopy ? `golden copy ${lookup.goldenCopy.slice(0, 10)}` : 'live registry',
    matchedName: entity.name,
  };
}
