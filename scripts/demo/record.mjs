// Records the demo video for real: drives Jira on the demo site in headless Chrome (session copied
// from a signed-in Chrome), narrates with Piper (local TTS), and assembles an MP4 with ffmpeg.
// Every screen in the video is the live app; nothing is mocked.
//
//   node scripts/demo/record.mjs
// Env: DEMO_SITE, FORGE_EMAIL + FORGE_API_TOKEN (Jira REST setup), PIPER_MODEL, OUT_DIR
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openSession } from './session.mjs';
import { sleep, click, waitText, installCursor, findBox } from './ui.mjs';

const SITE = process.env.DEMO_SITE || 'https://one-atlas-lllr.atlassian.net';
const GLOBAL_PAGE = `${SITE}/jira/apps/d86d1b88-c157-40ff-926b-288eeec0bb41/741af73d-a058-4ad0-9e01-0e6a721789f1`;
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.join(process.env.OUT_DIR || path.resolve('..', 'demo-out'), STAMP);
const FRAMES = path.join(OUT, 'frames');
fs.mkdirSync(FRAMES, { recursive: true });
const PIPER_MODEL = process.env.PIPER_MODEL || path.resolve('..', 'voices', 'en_US-ryan-high.onnx');
const log = (...a) => console.log(`[record ${new Date().toLocaleTimeString()}]`, ...a);

// ---------------------------------------------------------------- narration
const SCRIPT = {
  intro: 'Before a company pays a new vendor, someone has to check them. Are they sanctioned? Excluded from Medicare? Who really owns them? Are they going under? Today that is seven government websites, a pile of screenshots, and no record of what was actually checked.',
  title: 'Counterparty puts that check inside Jira. One click, seven official sources, a clear verdict, and a receipt saved on the work item. It is a Forge app, with a Rovo agent and MCP tools.',
  intake: 'A requester opens an intake ticket: Vendor, Sberbank Capital. That is all they do. A Forge trigger sees the new work item and queues a screen in the background.',
  panelClear: 'Meanwhile, a contract renewal. Open Counterparty check from the apps menu, type the vendor, and run it. Seven sources run in parallel on a Forge queue, so the panel never times out.',
  resultClear: 'Clear to proceed. GLEIF confirms the legal entity in Delaware. SEC shows no distress filings. USAspending shows over a billion dollars of federal contracts. Every row names the exact data version it used.',
  panelBlock: 'A home health subcontractor is a different story. One Best Care is on the HHS Inspector General exclusion list. Paying it with Medicare money risks penalties, so the verdict is block, with the official record linked.',
  joins: 'The joins are where it earns its keep. Rosneft Deutschland is a German company, and its name is not on the sanctions list. But GLEIF shows its parent is Rosneft in Moscow, and the app screens that parent against OFAC too. Needs review.',
  intakeDone: 'Back on the intake ticket, the screen finished on its own. Blocked, labeled, and a receipt comment with the OFAC match, the list version, and a receipt ID for the audit trail.',
  jql: 'Results are indexed on the work item, so JQL works. Counterparty verdict equals block. Use it in filters, boards, and automation rules.',
  register: 'The register shows every vendor at a glance. A daily scheduled job rescreens open vendors against the newest lists, and comments when a verdict changes.',
  rovo: 'Or just ask. The Counterparty Analyst Rovo agent can screen a vendor and post the receipt. Because that writes to Jira, Rovo asks you to confirm first.',
  rovoAnswer: 'Sovcomflot is on the OFAC sanctions list. The agent answers with the verdict, the evidence link, the data versions, and the receipt ID.',
  rovoPosted: 'And because you confirmed it, the receipt is now on the work item, labeled block.',
  mcp: 'The same four tools are exposed through the Rovo MCP module, so Rovo Studio agents, Claude, or Cursor can screen vendors too. The repo ships a skill file for them.',
  outro: 'Counterparty. Due diligence with receipts, for procurement, compliance, and finance teams in regulated industries. Open source under MIT, from Tensorust.',
};

function narrate() {
  const dir = path.join(OUT, 'voice');
  fs.mkdirSync(dir, { recursive: true });
  const dur = {};
  for (const [k, text] of Object.entries(SCRIPT)) {
    const f = path.join(dir, `${k}.wav`);
    const r = spawnSync('python', ['-m', 'piper', '-m', PIPER_MODEL, '-f', f, '--length-scale', '0.93', '--sentence-silence', '0.2'], { input: text, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`piper failed: ${r.stderr}`);
    dur[k] = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim());
  }
  return dur;
}

// ---------------------------------------------------------------- Jira REST for setup only
const AUTH = 'Basic ' + Buffer.from(`${process.env.FORGE_EMAIL}:${process.env.FORGE_API_TOKEN}`).toString('base64');
async function jira(method, p, body) {
  const r = await fetch(SITE + p, { method, headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const BASE = new Set(['Vendor: Abbott Laboratories', 'Vendor: Wells Fargo & Company', 'Vendor: Baxter Healthcare Corporation', 'Vendor: Rosneft Deutschland GmbH', 'Vendor: Rosneft']);
async function setupData() {
  const d = await jira('POST', '/rest/api/3/search/jql', { jql: 'project = VEN ORDER BY key', fields: ['summary'], maxResults: 100 });
  const keep = {};
  const stale = [];
  for (const i of d.issues) {
    if (BASE.has(i.fields.summary) && !keep[i.fields.summary]) keep[i.fields.summary] = i.key;
    else stale.push(i.key);
  }
  // Earlier takes are archived (the demo account cannot delete), which also hides them from JQL.
  if (stale.length) await jira('PUT', '/rest/api/3/issue/archive', { issueIdsOrKeys: stale });
  const make = async summary => (await jira('POST', '/rest/api/3/issue', { fields: { project: { key: 'VEN' }, issuetype: { name: 'Task' }, summary } })).key;
  return {
    joins: keep['Vendor: Rosneft Deutschland GmbH'],
    renewal: await make('Analytics platform renewal (3 year contract)'),
    homeHealth: await make('Home health subcontractor for Q1 patient visits'),
    tanker: await make('Charter a tanker for the Q1 Baltic shipment'),
  };
}
async function waitForProperty(summary, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const d = await jira('POST', '/rest/api/3/search/jql', { jql: `project = VEN AND summary ~ "${summary}"`, fields: ['summary', 'comment'], properties: ['counterparty'], maxResults: 5 });
    const i = d.issues.find(x => x.properties && x.properties.counterparty && x.fields.comment && x.fields.comment.total > 0);
    if (i) return i.key;
    await sleep(5000);
  }
  return null;
}

// ---------------------------------------------------------------- capture
const frames = []; // { file, ts }
let frameNo = 0;
let cdp;
async function startCapture(page) {
  cdp = await page.createCDPSession();
  cdp.on('Page.screencastFrame', f => {
    const file = path.join(FRAMES, `f${String(++frameNo).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, ts: f.metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
}

async function caption(page, text) {
  await page.evaluate(text => {
    let el = document.getElementById('__cap');
    if (!el) {
      el = document.createElement('div');
      el.id = '__cap';
      el.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);max-width:1480px;background:rgba(9,30,66,0.9);color:#fff;font:600 27px/1.38 'Segoe UI',Arial,sans-serif;padding:14px 26px;border-radius:12px;z-index:2147483647;text-align:center;box-shadow:0 8px 28px rgba(0,0,0,.3);pointer-events:none";
      document.documentElement.appendChild(el);
    }
    el.textContent = text;
    el.style.display = text ? 'block' : 'none';
  }, text).catch(() => {});
}

// A scene keeps the frames between its start and end; everything between scenes (page loads) is cut.
const scenes = [];
let DUR;
async function scene(page, key, fn, { speedup = false, cap = true } = {}) {
  log('scene', key);
  await installCursor(page);
  if (cap) await caption(page, SCRIPT[key]);
  const start = Date.now() / 1000;
  await fn();
  const minEnd = start + DUR[key] + 0.8;
  while (Date.now() / 1000 < minEnd) { if (cap) await caption(page, SCRIPT[key]); await sleep(250); }
  if (cap) await caption(page, SCRIPT[key]);
  await sleep(150);
  scenes.push({ key, start, end: Date.now() / 1000, narr: DUR[key], speedup });
}

async function goto(page, url, readyText) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  if (readyText) await waitText(page, readyText, 60000);
  await sleep(2500);
  await installCursor(page);
}

const CARD_CSS = `body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0B1F3A;font-family:'Segoe UI',Arial,sans-serif;color:#fff}
.c{max-width:1500px;padding:0 80px}h1{font-size:84px;margin:0 0 18px;letter-spacing:-1px}h1 em{font-style:normal;color:#4BCE97}
p{font-size:38px;line-height:1.4;margin:0;color:#DCE3EE}.k{display:flex;gap:28px;margin-top:54px;flex-wrap:wrap}
.k div{background:#14325A;border-radius:16px;padding:22px 28px;font-size:25px;color:#C7D1DF;min-width:260px}.k b{display:block;font-size:40px;color:#fff;margin-bottom:6px}
.s{margin-top:40px;font-size:28px;color:#8FA3BF}`;
async function card(page, html) {
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${CARD_CSS}</style></head><body><div class="c">${html}</div></body></html>`);
  await sleep(300);
}

async function openPanel(page) {
  await click(page, 'button[data-testid*="apps-button-dropdown--trigger"]');
  await sleep(900);
  await click(page, '[role=menuitem]', 'Counterparty check');
  await waitText(page, 'Counterparty to screen', 60000);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('h2,h3,span,div')].find(e => e.children.length === 0 && /^Counterparty check$/.test(e.textContent.trim()));
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  await sleep(1200);
}

async function runPanel(page, name) {
  const input = await page.waitForSelector('input[placeholder^="Company or person"]', { timeout: 30000 });
  const b = await input.boundingBox();
  await page.mouse.move(b.x + 60, b.y + b.height / 2, { steps: 10 });
  await input.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await input.type(name, { delay: 45 });
  await sleep(300);
  await click(page, 'button', '^(Run check|Run again)$');
  await waitText(page, '(CLEAR|REVIEW|BLOCK): ', 120000);
  await sleep(800);
}

async function scrollBy(page, dy, steps = 12) {
  for (let i = 0; i < steps; i++) { await page.mouse.wheel({ deltaY: dy / steps }); await sleep(40); }
}

// ---------------------------------------------------------------- assembly
// Each scene is rendered to its own segment (with a speed badge when it was sped up), then the
// segments are joined and the narration is laid on top at each scene's start.
function ff(args) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + r.stderr.slice(-3000));
}
function assemble(outDir = OUT) {
  frames.sort((a, b) => a.ts - b.ts);
  const segDir = path.join(outDir, 'segments');
  fs.mkdirSync(segDir, { recursive: true });
  const font = 'C' + String.fromCharCode(92) + ':/Windows/Fonts/segoeuib.ttf';
  const segs = [];
  const audio = [];
  let t = 0;
  for (const s of scenes) {
    const real = s.end - s.start;
    const target = s.speedup ? Math.min(real, s.narr + 1.6) : real;
    const factor = real / target;
    const before = frames.filter(f => f.ts <= s.start).at(-1);
    const inside = frames.filter(f => f.ts > s.start && f.ts < s.end);
    const seq = [...(before ? [{ ...before, ts: s.start }] : []), ...inside];
    if (!seq.length) continue;
    const list = [];
    for (let i = 0; i < seq.length; i++) {
      const next = i + 1 < seq.length ? seq[i + 1].ts : s.end;
      list.push(`file '${seq[i].file.split(String.fromCharCode(92)).join('/')}'`, `duration ${Math.max(0.001, (next - seq[i].ts) / factor).toFixed(4)}`);
    }
    list.push(`file '${seq.at(-1).file.split(String.fromCharCode(92)).join('/')}'`);
    const listFile = path.join(segDir, `${s.key}.txt`);
    fs.writeFileSync(listFile, list.join('\n'));
    const vf = ['fps=30', 'scale=1920:1080:force_original_aspect_ratio=decrease', 'pad=1920:1080:(ow-iw)/2:(oh-ih)/2'];
    if (factor > 1.15) vf.push(`drawtext=fontfile='${font}':text='${factor.toFixed(1)}x speed':x=w-tw-30:y=70:fontsize=24:fontcolor=white:box=1:boxcolor=0x091E42CC:boxborderw=10`);
    vf.push('format=yuv420p');
    const seg = path.join(segDir, `${String(segs.length).padStart(2, '0')}-${s.key}.mp4`);
    ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-vf', vf.join(','), '-t', target.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', seg]);
    segs.push(seg);
    audio.push({ file: path.join(outDir, 'voice', `${s.key}.wav`), at: t + 0.2 });
    t += target;
  }
  const segList = path.join(segDir, 'all.txt');
  fs.writeFileSync(segList, segs.map(f => `file '${f.split(String.fromCharCode(92)).join('/')}'`).join('\n'));
  const silent = path.join(outDir, 'video-silent.mp4');
  ff(['-f', 'concat', '-safe', '0', '-i', segList, '-c', 'copy', silent]);
  const out = path.join(outDir, 'counterparty-demo.mp4');
  const args = ['-i', silent];
  for (const a of audio) args.push('-i', a.file);
  const mix = audio.map((a, i) => `[${i + 1}:a]adelay=${Math.round(a.at * 1000)}|${Math.round(a.at * 1000)}[a${i}]`).join(';') + ';' + audio.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${audio.length}:normalize=0,apad[aout]`;
  ff([...args, '-filter_complex', mix, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-t', t.toFixed(2), '-movflags', '+faststart', out]);
  log(`video: ${out} (${t.toFixed(1)}s)`);
  return { out, total: t };
}

// ---------------------------------------------------------------- main
async function main() {
  DUR = narrate();
  log('narration seconds', Object.values(DUR).reduce((a, b) => a + b, 0).toFixed(1));
  const keys = await setupData();
  log('issues', keys);
  const { browser, page } = await openSession();
  try {
    await card(page, '');
    await startCapture(page);

    await scene(page, 'intro', async () => {
      await card(page, `<h1>Who are we about to <em>pay</em>?</h1><p>Sanctions. Medicare exclusions. Ownership. Distress. Today: seven government websites and a pile of screenshots.</p>`);
    }, { cap: false });
    await scene(page, 'title', async () => {
      await card(page, `<h1>Counter<em>party</em></h1><p>Third-party due diligence with receipts, inside Jira.</p><div class="k"><div><b>7</b>official public sources</div><div><b>1</b>click, or zero on intake</div><div><b>CLEAR / REVIEW / BLOCK</b>with evidence links</div></div><p class="s">Built on Atlassian Forge. Rovo agent and MCP tools included.</p>`);
    }, { cap: false });

    // Intake: a requester files the ticket inline in the project list.
    await goto(page, `${SITE}/jira/core/projects/VEN/list`, 'Vendor: Rosneft');
    await scene(page, 'intake', async () => {
      // The inline "+ Create" row at the bottom of the list (not the global Create button).
      const b = await page.evaluate(() => {
        const el = [...document.querySelectorAll('button,[role=button]')].filter(e => /^\+?\s*Create$/.test((e.innerText || '').trim()) && e.getBoundingClientRect().y > 200).at(-1);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.move(b.x, b.y, { steps: 14 });
      await sleep(250);
      await page.mouse.click(b.x, b.y);
      await sleep(900);
      await page.keyboard.type('Vendor: Sberbank Capital', { delay: 55 });
      await sleep(500);
      await page.keyboard.press('Enter');
      await waitText(page, 'Vendor: Sberbank Capital', 20000);
      await sleep(1500);
    });

    await goto(page, `${SITE}/browse/${keys.renewal}`, 'Analytics platform renewal');
    await scene(page, 'panelClear', async () => {
      await openPanel(page);
      await runPanel(page, 'Palantir Technologies Inc.');
    }, { speedup: true });
    await scene(page, 'resultClear', async () => {
      await sleep(1500);
      await scrollBy(page, 260);
      await sleep(2500);
    });

    await goto(page, `${SITE}/browse/${keys.homeHealth}`, 'Home health subcontractor');
    await scene(page, 'panelBlock', async () => {
      await openPanel(page);
      await runPanel(page, '1 Best Care, Inc.');
      await sleep(1000);
      await scrollBy(page, 320);
    }, { speedup: true });

    await goto(page, `${SITE}/browse/${keys.joins}`, 'Rosneft Deutschland');
    await scene(page, 'joins', async () => {
      await openPanel(page);
      await sleep(1500);
      await scrollBy(page, 380);
      await sleep(2000);
    });

    // By now the intake trigger has run (it typically lands within a few minutes).
    const intakeKey = await waitForProperty('Sberbank Capital', 300000);
    log('intake screened', intakeKey);
    await goto(page, `${SITE}/browse/${intakeKey}`, 'Counterparty check: BLOCK');
    await scene(page, 'intakeDone', async () => {
      await sleep(1200);
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('h3,h2,span,div,p')].find(e => e.children.length === 0 && /^Counterparty check: BLOCK/.test(e.textContent.trim()));
        if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
      await sleep(3000);
      await scrollBy(page, 300);
    });

    await goto(page, `${SITE}/issues/?jql=${encodeURIComponent('counterpartyVerdict = BLOCK ORDER BY created DESC')}`, 'Vendor: Rosneft');
    await scene(page, 'jql', async () => {
      const gotIt = await findBox(page, 'button', '^Got it$');
      if (gotIt) await click(page, 'button', '^Got it$');
      await sleep(500);
      const jqlTab = await findBox(page, 'button,[role=radio],label', '^JQL$');
      if (jqlTab) await click(page, 'button,[role=radio],label', '^JQL$');
      await sleep(2500);
    });

    await goto(page, GLOBAL_PAGE, 'Rescreen all now');
    await scene(page, 'register', async () => {
      await sleep(1500);
      const b = await findBox(page, 'button', '^Rescreen all now$');
      if (b) await page.mouse.move(b.x, b.y, { steps: 15 });
      await sleep(2500);
    });

    await goto(page, `${SITE}/browse/${keys.tanker}`, 'Charter a tanker');
    let confirmed = false;
    await scene(page, 'rovo', async () => {
      await click(page, 'button', '^Ask Rovo$');
      await sleep(2500);
      await click(page, '[data-testid=agent-title-pressable]');
      await sleep(1000);
      const search = await page.waitForSelector('input[placeholder="Search agents"]', { timeout: 15000 });
      await search.type('Counterparty', { delay: 40 });
      await sleep(1200);
      await click(page, '[role=menuitem],[role=option],button,div', '^Counterparty Analyst$');
      await sleep(1800);
      await click(page, '[contenteditable=true]');
      await page.keyboard.type('Screen Sovcomflot for this work item and post the receipt', { delay: 30 });
      await page.keyboard.press('Enter');
      for (let i = 0; i < 90; i++) {
        await sleep(1000);
        if (await findBox(page, 'button', '^Confirm selected$')) break;
      }
      await sleep(1200);
      if (await findBox(page, 'button', '^Confirm selected$')) { await click(page, 'button', '^Confirm selected$'); confirmed = true; }
    }, { speedup: true });
    log('confirmed', confirmed);
    await scene(page, 'rovoAnswer', async () => {
      for (let i = 0; i < 150; i++) {
        await sleep(1000);
        const done = await page.evaluate(() => {
          const t = document.body.innerText;
          return /Receipt[^\n]{0,20}[0-9a-f]{12,}/i.test(t) && !/is thinking|Invoking tool/i.test(t.slice(-3000));
        });
        if (done) break;
      }
      await sleep(4000);
    }, { speedup: true });

    await goto(page, `${SITE}/browse/${keys.tanker}`, 'Counterparty check: BLOCK');
    await scene(page, 'rovoPosted', async () => {
      await sleep(800);
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('h3,h2,span,div,p')].find(e => e.children.length === 0 && /^Counterparty check: BLOCK/.test(e.textContent.trim()));
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
      await sleep(2000);
    });

    await scene(page, 'mcp', async () => {
      await card(page, `<h1>Same tools, any <em>agent</em></h1><p>The rovo:mcp module exposes all four actions to Rovo Studio agents and external MCP clients.</p><div class="k"><div><b>screen-counterparty</b>read-only screen</div><div><b>screen-issue-counterparty</b>screen, store, post receipt</div><div><b>list-counterparties</b>by verdict</div><div><b>get-counterparty-receipt</b>evidence and history</div></div><p class="s">mcp.atlassian.com/forge/d86d1b88-c157-40ff-926b-288eeec0bb41 &nbsp;+&nbsp; docs/skill.md</p>`);
    }, { cap: false });
    await scene(page, 'outro', async () => {
      await card(page, `<h1>Counter<em>party</em></h1><p>Due diligence with receipts, inside Jira.</p><div class="k"><div><b>Forge</b>issue panel, global page, queue, triggers, KVS, JQL index</div><div><b>Rovo</b>agent, actions, MCP</div></div><p class="s">github.com/Mattbusel/counterparty-for-jira &nbsp;|&nbsp; MIT &nbsp;|&nbsp; Tensorust LLC</p>`);
    }, { cap: false });
    await sleep(800);
    await cdp.send('Page.stopScreencast').catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, 'scenes.json'), JSON.stringify(scenes, null, 2));
  fs.writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify(frames));
  const v = assemble();
  if (v.total > 178) log(`WARNING: ${v.total.toFixed(1)}s is over 3 minutes.`);
}

if (process.argv[2] === '--assemble') {
  // Re-assemble an earlier capture: node scripts/demo/record.mjs --assemble <capture dir>
  const dir = process.argv[3];
  scenes.push(...JSON.parse(fs.readFileSync(path.join(dir, 'scenes.json'), 'utf8')));
  if (fs.existsSync(path.join(dir, 'frames.json'))) frames.push(...JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8')));
  else throw new Error('no frames.json in ' + dir);
  assemble(dir);
} else {
  main().catch(e => { console.error(e); process.exit(1); });
}
