// The app's use cases, shared by the issue panel, the triggers, the queue consumer and the Rovo actions.
import { fetch } from '@forge/api';
import { kvs } from '@forge/kvs';
import { Queue } from '@forge/events';
import { screenCounterparty } from '../core/screen.js';
import { receiptAdf, issueProperty, vendorFromSummary } from '../core/receipt.js';
import { getIssue, setIssueProperty, addComment, setVerdictLabel, PROPERTY_KEY } from './jira.js';

export const queue = new Queue({ key: 'screening-queue' });

// Forge's fetch only reaches hosts declared in manifest egress, which keeps the app honest about where data goes.
export const runScreen = name => screenCounterparty(name, { fetch });

const reportKey = issueId => `report-${issueId}`;
const historyKey = issueId => `history-${issueId}`;
const jobKey = jobId => `job-${String(jobId).replace(/[^A-Za-z0-9_-]/g, '')}`;

export async function saveJob(jobId, value) { await kvs.set(jobKey(jobId), { ...value, at: new Date().toISOString() }); }
export async function getJob(jobId) { return kvs.get(jobKey(jobId)); }
export async function getReport(issueId) { return kvs.get(reportKey(issueId)); }
export async function getHistory(issueId) { return (await kvs.get(historyKey(issueId))) || []; }

/**
 * Screen the counterparty on an issue and record the result:
 * full report in app storage, compact result as an indexed issue property, verdict label,
 * and (when asked, or when the verdict changed on a rescreen) a receipt comment.
 */
export async function screenIssue({ issueId, name, post = false, rescreen = false, mode = 'app', by }) {
  const issue = await getIssue(issueId, mode);
  const vendor = (name && String(name).trim()) || (issue.properties && issue.properties[PROPERTY_KEY] && issue.properties[PROPERTY_KEY].vendor) || vendorFromSummary(issue.fields.summary);
  if (!vendor) throw new Error(`No counterparty name on ${issue.key}. Put it in the summary as "Vendor: Name" or type it in the panel.`);
  const previous = await getReport(issue.id);
  const report = await runScreen(vendor);
  await kvs.set(reportKey(issue.id), report);
  const history = await getHistory(issue.id);
  history.unshift({ verdict: report.verdict, receiptId: report.receiptId, checkedAt: report.checkedAt, vendor });
  await kvs.set(historyKey(issue.id), history.slice(0, 20));
  await setIssueProperty(issue.id, issueProperty(report), mode);
  await setVerdictLabel(issue.id, report.verdict, mode).catch(e => console.warn(`label: ${e.message}`));
  const changed = previous && previous.query === report.query && previous.verdict !== report.verdict;
  if (post || (rescreen && changed)) {
    const adf = receiptAdf(report, { by: by || 'Counterparty' });
    if (changed) {
      adf.content.unshift({ type: 'paragraph', content: [{ type: 'text', text: `Verdict changed from ${previous.verdict} to ${report.verdict} on the scheduled rescreen.`, marks: [{ type: 'strong' }] }] });
    }
    await addComment(issue.id, adf, mode);
  }
  return { issueKey: issue.key, issueId: issue.id, report, changed: Boolean(changed), previousVerdict: previous ? previous.verdict : null };
}

/** Queue a screen so the UI never waits on a 25-second resolver limit. */
export async function enqueueScreen(body) {
  const { jobId } = await queue.push({ body });
  await saveJob(jobId, { status: 'queued', issueId: body.issueId });
  return jobId;
}
