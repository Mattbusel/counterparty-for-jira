// Turns a screen report into the three shapes the app needs:
//  - an Atlassian Document Format (ADF) comment for the Jira issue (the "receipt"),
//  - a compact issue property that Jira indexes for JQL,
//  - a compact JSON summary for Rovo agents and MCP clients.

const VERDICT_TEXT = {
  CLEAR: 'Clear to proceed',
  REVIEW: 'Needs human review',
  BLOCK: 'Do not proceed',
};
const PANEL = { CLEAR: 'success', REVIEW: 'warning', BLOCK: 'error' };
const SEV_TEXT = { block: 'Match', review: 'Review', info: 'Info', none: 'Clear' };

// Prefixes people put on intake tickets before the vendor name.
const INTAKE = /^\s*(?:\[[^\]]*\]\s*)?(?:new\s+)?(?:vendor|supplier|counterparty|third[- ]party|partner|contractor)(?:\s+(?:onboarding|intake|request|review|check|due diligence|screening))?\s*[:\-|]\s*/i;
const ONBOARD = /^\s*(?:please\s+)?(?:onboard(?:ing)?|screen|vet|check)\s+(?:vendor\s+|supplier\s+)?/i;

/** Pull the counterparty name out of an issue summary, or null if it is not an intake ticket. */
export function vendorFromSummary(summary) {
  const s = String(summary || '').trim();
  let m = s.match(INTAKE);
  if (m) return tidy(s.slice(m[0].length));
  m = s.match(ONBOARD);
  if (m) return tidy(s.slice(m[0].length));
  return null;
}

function tidy(name) {
  const t = name.replace(/\s+(?:as\s+(?:a\s+)?(?:new\s+)?(?:vendor|supplier)|for\s+.*)$/i, '').replace(/[.\s]+$/, '').trim();
  return t.length >= 2 ? t.slice(0, 200) : null;
}

const text = (t, marks) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const link = (t, href) => text(t, [{ type: 'link', attrs: { href } }]);
const strong = t => text(t, [{ type: 'strong' }]);
const para = (...content) => ({ type: 'paragraph', content: content.filter(Boolean) });
const cell = (content, header) => ({ type: header ? 'tableHeader' : 'tableCell', attrs: {}, content: [para(...content)] });

/** The receipt comment, in ADF. */
export function receiptAdf(report, { by = 'Counterparty' } = {}) {
  const verdict = report.verdict;
  const rows = report.sources.map(s => ({
    type: 'tableRow',
    content: [
      cell([text(s.label)]),
      cell([strong(SEV_TEXT[s.severity] || s.severity), text(`: ${s.headline}`)]),
      cell([text(s.asOf || '')]),
    ],
  }));
  const evidence = [];
  for (const s of report.sources) {
    for (const f of s.findings) {
      if (!(f.flag || f.strong || s.severity === 'block' || s.severity === 'review') || !f.url) continue;
      evidence.push({
        type: 'listItem',
        content: [para(strong(`${s.label}: `), link(f.title, f.url), f.detail ? text(` (${String(f.detail).slice(0, 220)})`) : null)],
      });
      if (evidence.length >= 10) break;
    }
  }
  const identity = report.identity
    ? [text(' Registered as '), link(`${report.identity.name}`, `https://search.gleif.org/#/record/${report.identity.lei}`), text(` (${report.identity.jurisdiction}).`)]
    : [];
  const content = [
    { type: 'heading', attrs: { level: 3 }, content: [text(`Counterparty check: ${verdict}. ${VERDICT_TEXT[verdict]}`)] },
    para(text('Screened '), strong(report.query), text(` against ${report.sources.length} public sources.`), ...identity),
    { type: 'panel', attrs: { panelType: PANEL[verdict] }, content: report.reasons.map(r => para(text(r))) },
    { type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default' }, content: [
      { type: 'tableRow', content: [cell([text('Source')], true), cell([text('Result')], true), cell([text('Data version')], true)] },
      ...rows,
    ] },
  ];
  if (evidence.length) {
    content.push(para(strong('Evidence')));
    content.push({ type: 'bulletList', content: evidence });
  }
  content.push(para(text(`Receipt ${report.receiptId}, checked ${report.checkedAt.replace('T', ' ').slice(0, 16)} UTC by ${by}. Every finding links to the official record.`, [{ type: 'em' }])));
  return { type: 'doc', version: 1, content };
}

/** Small property stored on the issue and indexed by Jira for JQL (max 32 KB, we stay far below). */
export function issueProperty(report) {
  return {
    vendor: report.query,
    verdict: report.verdict,
    legalName: report.identity ? report.identity.name : '',
    lei: report.identity ? report.identity.lei : '',
    flagged: report.sources.filter(s => s.severity === 'block' || s.severity === 'review').map(s => s.source),
    reasons: report.reasons.slice(0, 5),
    receiptId: report.receiptId,
    checkedAt: report.checkedAt.slice(0, 19) + 'Z',
  };
}

/** Compact report for an LLM: verdict first, then only what explains it, with links. */
export function agentSummary(report) {
  return {
    counterparty: report.query,
    verdict: report.verdict,
    meaning: VERDICT_TEXT[report.verdict],
    registeredAs: report.identity || null,
    reasons: report.reasons,
    sources: report.sources.map(s => ({
      source: s.label,
      result: SEV_TEXT[s.severity] || s.severity,
      summary: s.headline,
      dataVersion: s.asOf,
      evidence: s.findings.slice(0, 3).map(f => ({ title: f.title, detail: f.detail ? String(f.detail).slice(0, 200) : undefined, url: f.url, matchScore: f.score })),
    })),
    receiptId: report.receiptId,
    checkedAt: report.checkedAt,
  };
}
