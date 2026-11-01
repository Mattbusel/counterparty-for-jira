// Opens a headless Chrome signed in to the demo Atlassian site by copying the Atlassian session
// cookies from an already signed-in Chrome (DevTools on SOURCE_CDP, default port 9337).
// Nothing in the source browser is changed: cookies are only read.
import puppeteer from 'puppeteer-core';

export const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SOURCE = process.env.SOURCE_CDP || 'http://127.0.0.1:9337';

async function readCookies() {
  const { webSocketDebuggerUrl } = await (await fetch(`${SOURCE}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  const res = await new Promise(r => {
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) r(m); };
    ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' }));
  });
  ws.close();
  return (res.result.cookies || []).filter(c => /atlassian|atl-paas/.test(c.domain));
}

export async function openSession({ width = 1920, height = 1080 } = {}) {
  const cookies = await readCookies();
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: process.env.DEMO_HEADFUL ? false : 'new',
    defaultViewport: { width, height },
    args: [`--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check', '--lang=en-US', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
  const cdp = await page.createCDPSession();
  await cdp.send('Network.setCookies', {
    cookies: cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
      sameSite: c.sameSite, expires: c.expires > 0 ? c.expires : undefined,
    })),
  });
  return { browser, page, cookieCount: cookies.length };
}
