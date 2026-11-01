// Small helpers that drive the Jira UI with real mouse and keyboard events (puppeteer page).
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Center of the first visible element matching selector whose text or aria-label matches `text`. */
export async function findBox(page, selector, text) {
  return page.evaluate((selector, text) => {
    const re = text ? new RegExp(text, 'i') : null;
    for (const el of document.querySelectorAll(selector)) {
      const label = `${el.getAttribute('aria-label') || ''} ${el.innerText || el.value || ''}`.trim();
      if (re && !re.test(label)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.bottom < 0 || r.top > window.innerHeight) { el.scrollIntoView({ block: 'center' }); }
      const q = el.getBoundingClientRect();
      return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
    }
    return null;
  }, selector, text ? text.source || text : null);
}

export async function waitBox(page, selector, text, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const b = await findBox(page, selector, text);
    if (b) return b;
    await sleep(300);
  }
  throw new Error(`not found: ${selector} ${text || ''}`);
}

/** Move the mouse smoothly to an element and click it, so the viewer sees where the click lands. */
export async function click(page, selector, text, timeout) {
  const b = await waitBox(page, selector, text, timeout);
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await sleep(250);
  await page.mouse.click(b.x, b.y);
  return b;
}

export async function waitText(page, text, timeout = 60000) {
  const re = text instanceof RegExp ? text : new RegExp(text, 'i');
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const ok = await page.evaluate(src => new RegExp(src, 'i').test(document.body.innerText), re.source).catch(() => false);
    if (ok) return true;
    await sleep(400);
  }
  throw new Error(`text not found: ${re}`);
}

/** Scroll the element containing `text` into the middle of the viewport. */
export async function scrollToText(page, text, block = 'start') {
  await page.evaluate((src, block) => {
    const re = new RegExp(src, 'i');
    const all = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,strong,span,div,p')];
    const el = all.find(e => e.children.length === 0 && re.test(e.textContent || ''));
    if (el) el.scrollIntoView({ block, behavior: 'smooth' });
  }, text, block);
}

/** A fake cursor so clicks are visible in a headless recording. */
export async function installCursor(page) {
  await page.evaluate(() => {
    if (document.getElementById('__cursor')) return;
    const c = document.createElement('div');
    c.id = '__cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(12,102,228,.35);border:2px solid #0C66E4;z-index:2147483646;pointer-events:none;transition:transform .08s';
    document.documentElement.appendChild(c);
    document.addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    document.addEventListener('mousedown', () => { c.style.transform = 'scale(.7)'; }, true);
    document.addEventListener('mouseup', () => { c.style.transform = 'scale(1)'; }, true);
  }).catch(() => {});
}
