// Every Forge function the manifest points at lives behind this file.
import ResolverModule from '@forge/resolver';

// @forge/resolver ships CommonJS; under "type": "module" its class sits on .default.
const Resolver = ResolverModule.default || ResolverModule;
import { vendorFromSummary, receiptAdf, agentSummary } from './core/receipt.js';
import { getIssue, addComment, searchScreened, PROPERTY_KEY } from './forge/jira.js';
import { screenIssue, enqueueScreen, saveJob, getJob, getReport, getHistory, runScreen } from './forge/service.js';

// ---------------------------------------------------------------- UI resolvers
const resolver = new Resolver();

/** Issue panel: everything needed to draw the panel for the current issue. */
resolver.define('getPanelState', async ({ context }) => {
  const issueId = context.extension.issue.id;
  const issue = await getIssue(issueId, 'user');
  const report = await getReport(issueId);
  const history = await getHistory(issueId);
  const stored = issue.properties && issue.properties[PROPERTY_KEY];
  return {
    issueKey: issue.key,
    suggestedName: (stored && stored.vendor) || vendorFromSummary(issue.fields.summary) || '',
    report: report || null,
    history,
  };
});

/** Issue panel: start a screen in the background and hand back a job id to poll. */
resolver.define('startScreen', async ({ payload, context }) => {
  const issueId = context.extension.issue.id;
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('Type the counterparty name first.');
  // Reading the issue as the user first means only people who can see the issue can screen on it.
  await getIssue(issueId, 'user');
  const jobId = await enqueueScreen({ issueId, name, post: false, requestedBy: context.accountId });
  return { jobId };
});

resolver.define('getJob', async ({ payload }) => (await getJob(payload.jobId)) || { status: 'unknown' });

/** Issue panel: post the stored receipt as a comment written by the person who clicked. */
resolver.define('postReceipt', async ({ context }) => {
  const issueId = context.extension.issue.id;
  const report = await getReport(issueId);
  if (!report) throw new Error('Run a check first.');
  await addComment(issueId, receiptAdf(report, { by: 'Counterparty for Jira' }), 'user');
  return { ok: true };
});

/** Register page: every screened counterparty the user can see. */
resolver.define('getRegister', async () => {
  const rows = await searchScreened({ mode: 'user', max: 100 });
  return { rows };
});

/** Register page: rescreen every open counterparty now (the daily job does the same). */
resolver.define('rescreenAll', async () => {
  const rows = await searchScreened({ mode: 'user', max: 50 });
  let queued = 0;
  for (const r of rows) {
    if (!r.result || !r.result.vendor) continue;
    await enqueueScreen({ issueId: r.id, name: r.result.vendor, rescreen: true });
    queued++;
  }
  return { queued };
});

export const handler = resolver.getDefinitions();

// ---------------------------------------------------------------- background work

/** Queue consumer: runs the screen, writes the results, records the job outcome for the UI. */
export async function consumer(event) {
  const body = event.body || {};
  const jobId = event.jobId;
  try {
    await saveJob(jobId, { status: 'running', issueId: body.issueId });
    const out = await screenIssue({ issueId: body.issueId, name: body.name, post: Boolean(body.post), rescreen: Boolean(body.rescreen) });
    await saveJob(jobId, { status: 'done', issueId: body.issueId, verdict: out.report.verdict, receiptId: out.report.receiptId, changed: out.changed });
  } catch (e) {
    console.error(`screen failed for issue ${body.issueId}: ${e.message}`);
    await saveJob(jobId, { status: 'error', issueId: body.issueId, error: e.message });
  }
}

/** Product trigger: a new intake ticket ("Vendor: Acme Corp") gets screened and a receipt posted. */
export async function onIssueCreated(event) {
  const issue = event.issue;
  if (!issue || !issue.fields) return;
  const labels = (issue.fields.labels || []).map(l => String(l).toLowerCase());
  const name = vendorFromSummary(issue.fields.summary);
  const tagged = labels.includes('vendor') || labels.includes('counterparty') || labels.includes('supplier');
  if (!name && !tagged) return;
  await enqueueScreen({ issueId: issue.id, name: name || null, post: true });
  console.log(`queued intake screen for ${issue.key}: ${name || '(from labels)'}`);
}

/** Scheduled trigger: sanctions and exclusion lists change daily, so open counterparties are rescreened. */
export async function dailyRescreen() {
  const rows = await searchScreened({ mode: 'app', max: 100 });
  let n = 0;
  for (const r of rows) {
    if (!r.result || !r.result.vendor || r.statusCategory === 'done') continue;
    await enqueueScreen({ issueId: r.id, name: r.result.vendor, rescreen: true });
    n++;
  }
  console.log(`daily rescreen queued ${n} counterparties`);
}

// ---------------------------------------------------------------- Rovo actions and MCP tools

const issueKeyFrom = payload => {
  const typed = String(payload.issueKey || '').trim().toUpperCase();
  if (/^[A-Z][A-Z0-9_]+-\d+$/.test(typed)) return typed;
  const ctx = payload.context && payload.context.jira;
  return ctx ? String(ctx.issueKey || ctx.issueId || '') : '';
};

/** Screen any name against every source. Read-only: nothing is written to Jira. */
export async function actionScreen(payload) {
  const name = String(payload.counterpartyName || '').trim();
  if (!name) return { error: 'counterpartyName is required.' };
  try {
    return agentSummary(await runScreen(name));
  } catch (e) {
    return { error: e.message };
  }
}

/** Screen the counterparty on an issue, store the result and post the receipt comment. */
export async function actionScreenIssue(payload) {
  const key = issueKeyFrom(payload);
  if (!key) return { error: 'Tell me which issue (for example VO-12), or open the issue first.' };
  try {
    const out = await screenIssue({ issueId: key, name: payload.counterpartyName, post: true, mode: 'user', by: 'Counterparty Analyst (Rovo)' });
    return { issue: out.issueKey, posted: true, ...agentSummary(out.report) };
  } catch (e) {
    return { error: e.message };
  }
}

/** Counterparties on file, optionally filtered by verdict (CLEAR, REVIEW or BLOCK). */
export async function actionListFlagged(payload) {
  const verdict = String(payload.verdict || '').toUpperCase();
  const rows = await searchScreened({ mode: 'user', verdict: ['CLEAR', 'REVIEW', 'BLOCK'].includes(verdict) ? verdict : undefined, max: 50 });
  return {
    count: rows.length,
    counterparties: rows.map(r => ({
      issue: r.key, status: r.status, counterparty: r.result && r.result.vendor,
      verdict: r.result && r.result.verdict, reasons: r.result && r.result.reasons,
      checkedAt: r.result && r.result.checkedAt, receiptId: r.result && r.result.receiptId,
    })),
  };
}

/** The stored receipt for one issue: what was checked, when, and the evidence. */
export async function actionGetReceipt(payload) {
  const key = issueKeyFrom(payload);
  if (!key) return { error: 'Which issue? Give an issue key such as VO-12.' };
  const issue = await getIssue(key, 'user');
  const report = await getReport(issue.id);
  if (!report) return { issue: issue.key, error: 'No counterparty check on this issue yet.' };
  return { issue: issue.key, history: await getHistory(issue.id), ...agentSummary(report) };
}
