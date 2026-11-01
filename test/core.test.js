// Unit tests for the screening engine. Run: npm test  (live network tests: npm run test:live)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean, tokens, jaroWinkler, scoreNames, NameIndex } from '../src/core/normalize.js';
import { parseCsv, ofacCell } from '../src/core/csv.js';
import { vendorFromSummary, receiptAdf, issueProperty, agentSummary } from '../src/core/receipt.js';
import { decide, receiptId, screenCounterparty } from '../src/core/screen.js';
import { gleifResult } from '../src/core/sources/gleif.js';
import { clearCache } from '../src/core/cache.js';

test('clean strips accents, punctuation and case', () => {
  assert.equal(clean('Société Générale, S.A.'), 'SOCIETE GENERALE S A');
  assert.equal(clean('AT&T Inc.'), 'AT AND T INC');
});

test('tokens drop legal forms and connector words', () => {
  assert.deepEqual(tokens('Public Joint Stock Company Sberbank of Russia'), ['SBERBANK', 'RUSSIA']);
  assert.deepEqual(tokens('Acme Medical Supply, Inc.'), ['ACME', 'MEDICAL', 'SUPPLY']);
  assert.deepEqual(tokens('LLC'), ['LLC']); // never empty
});

test('jaroWinkler behaves', () => {
  assert.equal(jaroWinkler('MARTHA', 'MARTHA'), 1);
  assert.ok(jaroWinkler('MARTHA', 'MARHTA') > 0.95);
  assert.ok(jaroWinkler('ACME', 'ZETA') < 0.7);
});

test('scoreNames: exact, containment and one-word guard', () => {
  assert.equal(scoreNames(tokens('Sberbank Capital LLC'), tokens('LIMITED LIABILITY COMPANY SBERBANK CAPITAL')).score, 1);
  const partial = scoreNames(tokens('Sberbank'), tokens('SBERBANK OF RUSSIA'));
  assert.ok(partial.score >= 0.8 && partial.score < 0.92, `partial ${partial.score}`);
  assert.equal(scoreNames(tokens('Delta'), tokens('DELTOID TRADING')).score, 0);
  const typo = scoreNames(tokens('Rosoboronexprt'), tokens('ROSOBORONEXPORT'));
  assert.ok(typo.score > 0.9, `typo ${typo.score}`);
});

test('NameIndex finds aliases and collapses them to one party', () => {
  const idx = new NameIndex();
  const party = { uid: 'SDN:1', name: 'OPEN JOINT-STOCK COMPANY ROSNEFT OIL COMPANY' };
  idx.add(party.name, party);
  idx.add('ROSNEFT', party);
  idx.add('ACME WIDGETS', { uid: 'X:2', name: 'ACME WIDGETS' });
  const hits = idx.search('Rosneft');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].record.uid, 'SDN:1');
  assert.equal(hits[0].score, 1);
  assert.equal(idx.search('Totally Unrelated Name').length, 0);
});

test('parseCsv handles quotes, commas, CRLF and the OFAC EOF byte', () => {
  const rows = parseCsv('1,"A, B","say ""hi"""\r\n2,-0- ,x\r\n\u001a');
  assert.deepEqual(rows[0], ['1', 'A, B', 'say "hi"']);
  assert.equal(ofacCell(rows[1][1]), '');
  assert.equal(rows.length, 2);
});

test('vendorFromSummary reads common intake titles', () => {
  assert.equal(vendorFromSummary('Vendor: Acme Medical Supply Inc.'), 'Acme Medical Supply Inc');
  assert.equal(vendorFromSummary('New supplier - Globex Corporation'), 'Globex Corporation');
  assert.equal(vendorFromSummary('[Procurement] Vendor onboarding: Initech LLC'), 'Initech LLC');
  assert.equal(vendorFromSummary('Onboard Umbrella Health as a new vendor'), 'Umbrella Health');
  assert.equal(vendorFromSummary('Fix login button'), null);
});

const src = (source, severity, extra = {}) => ({
  source, label: source.toUpperCase(), severity, status: severity, headline: `${source} ${severity}`,
  findings: [{ title: `${source} finding`, url: `https://example.gov/${source}`, flag: severity !== 'none' }], asOf: 'today', ...extra,
});

test('decide: block beats review beats clear', () => {
  assert.equal(decide([src('ofac', 'none'), src('sec', 'info')]).verdict, 'CLEAR');
  assert.equal(decide([src('ofac', 'none'), src('sec', 'review')]).verdict, 'REVIEW');
  const d = decide([src('ofac', 'block'), src('sec', 'review')]);
  assert.equal(d.verdict, 'BLOCK');
  assert.equal(d.reasons[0], 'OFAC: ofac block');
});

test('receipt id is stable and changes with the findings', () => {
  const r = { query: 'Acme', verdict: 'CLEAR', checkedAt: '2026-11-01T00:00:00.000Z', sources: [src('ofac', 'none')] };
  assert.equal(receiptId(r), receiptId({ ...r }));
  assert.notEqual(receiptId(r), receiptId({ ...r, verdict: 'REVIEW' }));
  assert.match(receiptId(r), /^[0-9a-f]{16}$/);
});

test('receipt ADF, issue property and agent summary carry the verdict and evidence', () => {
  const report = {
    query: 'Acme', verdict: 'BLOCK', reasons: ['OFAC: match'], checkedAt: '2026-11-01T10:00:00.000Z', receiptId: 'abc123',
    identity: { name: 'ACME LTD', lei: '5493000000000000000X', jurisdiction: 'GB' },
    sources: [src('ofac', 'block'), src('leie', 'none')],
  };
  const adf = receiptAdf(report);
  assert.equal(adf.type, 'doc');
  assert.match(JSON.stringify(adf), /Counterparty check: BLOCK/);
  assert.match(JSON.stringify(adf), /https:\/\/example.gov\/ofac/);
  const prop = issueProperty(report);
  assert.equal(prop.verdict, 'BLOCK');
  assert.deepEqual(prop.flagged, ['ofac']);
  assert.ok(JSON.stringify(prop).length < 32000);
  const sum = agentSummary(report);
  assert.equal(sum.meaning, 'Do not proceed');
  assert.equal(sum.sources[0].evidence[0].url, 'https://example.gov/ofac');
});

test('gleifResult flags a parent in a high-risk jurisdiction and a sanctioned owner', () => {
  const entity = { lei: 'L1', name: 'CHILD GMBH', entityStatus: 'ACTIVE', registrationStatus: 'ISSUED', jurisdiction: 'DE', country: 'DE', url: 'u1' };
  const parent = { lei: 'L2', name: 'PARENT PAO', jurisdiction: 'RU', country: 'RU', url: 'u2' };
  const r = gleifResult({ entity, directParent: parent, ultimateParent: parent }, [{ severity: 'block', parentName: 'PARENT PAO', findings: [{ title: 'PARENT PAO', detail: 'SDN', url: 'o' }] }]);
  assert.equal(r.severity, 'review');
  assert.ok(r.findings.some(f => /Direct parent registered in Russia/.test(f.title)));
  assert.ok(r.findings.some(f => /Owner on sanctions list/.test(f.title)));
  assert.equal(gleifResult(null).severity, 'info');
});

// A fake network that serves recorded-shape responses, so the whole pipeline runs offline.
function fakeFetch(routes) {
  return async (url, opts = {}) => {
    const hit = routes.find(([re]) => re.test(url));
    if (!hit) return { ok: false, status: 404, json: async () => ({}), text: async () => '', headers: { get: () => null } };
    const body = typeof hit[1] === 'function' ? hit[1](url, opts) : hit[1];
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: true, status: 200, url, json: async () => JSON.parse(text), text: async () => text, headers: { get: h => (h === 'last-modified' ? 'Tue, 27 Oct 2026 12:00:00 GMT' : null) } };
  };
}

test('screenCounterparty end to end on a fake network: sanctions alias blocks', async () => {
  clearCache();
  const fetch = fakeFetch([
    [/SDN\.CSV/, '100,"GLOBEX TRADING FZE",-0- ,"IRAN",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Linked To: X."\r\n'],
    [/ALT\.CSV/, '100,1,"aka","GLOBEX INTERNATIONAL",-0- \r\n'],
    [/CONS_PRIM\.CSV/, ''],
    [/CONS_ALT\.CSV/, ''],
    [/UPDATED\.csv/, 'LASTNAME,FIRSTNAME,MIDNAME,BUSNAME,GENERAL,SPECIALTY,UPIN,NPI,DOB,ADDRESS,CITY,STATE,ZIP,EXCLTYPE,EXCLDATE,REINDATE,WAIVERDATE,WVRSTATE\r\n,,,"OTHER CARE INC",OTHER BUSINESS,HOME HEALTH,,0,,1 MAIN,TOWN,NY,10001,1128b7,20200101,0,0,\r\n'],
    [/gleif/, { data: [] }],
    [/company_tickers/, { 0: { cik_str: 1, ticker: 'ZZZ', title: 'ZEBRA CO' } }],
    [/efts\.sec\.gov/, { hits: { hits: [] } }],
    [/usaspending/, { results: [] }],
    [/consumerfinance/, { aggregations: {} }],
    [/api\.fda\.gov/, { results: [] }],
  ]);
  const r = await screenCounterparty('Globex International', { fetch, now: Date.parse('2026-11-01T00:00:00Z') });
  assert.equal(r.verdict, 'BLOCK');
  const ofac = r.sources.find(s => s.source === 'ofac');
  assert.equal(ofac.severity, 'block');
  assert.match(ofac.findings[0].title, /GLOBEX TRADING FZE \(matched alias "GLOBEX INTERNATIONAL"\)/);
  assert.equal(ofac.asOf, 'list published 2026-10-27');
  assert.equal(r.sources.find(s => s.source === 'leie').severity, 'none');
  assert.equal(r.sources.length, 7);
});

test('screenCounterparty never calls a failed sanctions check clear', async () => {
  clearCache();
  const fetch = fakeFetch([
    [/UPDATED\.csv/, 'LASTNAME,FIRSTNAME,MIDNAME,BUSNAME,GENERAL,SPECIALTY,UPIN,NPI,DOB,ADDRESS,CITY,STATE,ZIP,EXCLTYPE,EXCLDATE,REINDATE,WAIVERDATE,WVRSTATE\r\n'],
    [/gleif/, { data: [] }],
    [/company_tickers/, {}],
    [/efts\.sec\.gov/, { hits: { hits: [] } }],
    [/usaspending/, { results: [] }],
    [/consumerfinance/, { aggregations: {} }],
    [/api\.fda\.gov/, { results: [] }],
  ]);
  const r = await screenCounterparty('Plain Vendor Co', { fetch });
  assert.equal(r.verdict, 'REVIEW');
  assert.equal(r.sources.find(s => s.source === 'ofac').status, 'error');
});

test('screenCounterparty rejects an empty name', async () => {
  await assert.rejects(screenCounterparty('  ', { fetch: async () => ({}) }), /Enter a company or person name/);
});
