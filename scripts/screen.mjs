// Run a real screen from the command line: node scripts/screen.mjs "Company name" [--json]
import { screenCounterparty } from '../src/core/screen.js';
const name = process.argv[2];
const r = await screenCounterparty(name, { fetch });
if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
console.log(`${r.query} => ${r.verdict}  (${r.tookMs} ms, receipt ${r.receiptId})`);
if (r.identity) console.log(`  identity: ${r.identity.name} LEI ${r.identity.lei} ${r.identity.jurisdiction}`);
for (const x of r.reasons) console.log('  - ' + x);
for (const s of r.sources) {
  console.log(`  [${s.severity}] ${s.label}: ${s.headline}  (${s.asOf})`);
  for (const f of s.findings.slice(0, 3)) console.log(`      * ${f.title}${f.score ? ' ' + f.score : ''} :: ${String(f.detail || '').slice(0, 140)}`);
}
