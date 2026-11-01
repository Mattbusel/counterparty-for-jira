// Jira REST calls the app makes. `who` is asUser() when a person clicked something
// (so Jira applies their permissions and the comment is theirs) and asApp() for background work.
import { asUser, asApp, route } from '@forge/api';

export const PROPERTY_KEY = 'counterparty';
const VERDICT_LABELS = ['counterparty-clear', 'counterparty-review', 'counterparty-block'];

export const as = mode => (mode === 'user' ? asUser() : asApp());

async function ok(res, what) {
  if (res.ok) return res.status === 204 ? null : res.json().catch(() => null);
  const body = await res.text().catch(() => '');
  throw new Error(`${what} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
}

export async function getIssue(issueIdOrKey, mode = 'app') {
  const res = await as(mode).requestJira(route`/rest/api/3/issue/${issueIdOrKey}?fields=summary,labels,project,status&properties=${PROPERTY_KEY}`);
  return ok(res, 'Read issue');
}

export async function setIssueProperty(issueIdOrKey, value, mode = 'app') {
  const res = await as(mode).requestJira(route`/rest/api/3/issue/${issueIdOrKey}/properties/${PROPERTY_KEY}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  return ok(res, 'Save issue property');
}

export async function addComment(issueIdOrKey, adf, mode = 'app') {
  const res = await as(mode).requestJira(route`/rest/api/3/issue/${issueIdOrKey}/comment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ body: adf }),
  });
  return ok(res, 'Add comment');
}

/** Swap the verdict label so boards, filters and automation can key off it. */
export async function setVerdictLabel(issueIdOrKey, verdict, mode = 'app') {
  const keep = `counterparty-${verdict.toLowerCase()}`;
  const update = { labels: [{ add: keep }, ...VERDICT_LABELS.filter(l => l !== keep).map(l => ({ remove: l }))] };
  const res = await as(mode).requestJira(route`/rest/api/3/issue/${issueIdOrKey}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update }),
  });
  return ok(res, 'Update labels');
}

/** Issues that carry a Counterparty result, newest first, with the stored property. */
export async function searchScreened({ verdict, max = 100, mode = 'app' } = {}) {
  const clauses = ['counterpartyVerdict IS NOT EMPTY'];
  if (verdict) clauses.push(`counterpartyVerdict = "${String(verdict).toUpperCase().replace(/[^A-Z]/g, '')}"`);
  const jql = `${clauses.join(' AND ')} ORDER BY updated DESC`;
  const res = await as(mode).requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jql, maxResults: Math.min(max, 100), fields: ['summary', 'status', 'project'], properties: [PROPERTY_KEY] }),
  });
  const d = await ok(res, 'Search issues');
  return (d.issues || []).map(i => ({
    id: i.id, key: i.key,
    summary: i.fields.summary,
    status: i.fields.status && i.fields.status.name,
    statusCategory: i.fields.status && i.fields.status.statusCategory && i.fields.status.statusCategory.key,
    project: i.fields.project && i.fields.project.key,
    result: (i.properties && i.properties[PROPERTY_KEY]) || null,
  }));
}
