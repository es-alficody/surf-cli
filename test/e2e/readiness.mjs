import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer";

// A server-held SPA response approximates an X++ debugger pause without
// attaching to a customer's server or changing their authenticated profile.
const delayMs = process.env.SURF_READINESS_LONG_TEST === "1" ? 130_000 : 1600;
const scratch = mkdtempSync(join(tmpdir(), "surf-readiness-"));
const extensionDir = join(scratch, "extension");
let browser;
let formRequests = 0;
const responseTimers = new Set();
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (request.url === "/form") {
    formRequests += 1;
    const timer = setTimeout(() => {
      responseTimers.delete(timer);
      response.end('<div class="orders-grid" role="grid" aria-label="Sales orders">Loaded orders</div>');
    }, delayMs);
    responseTimers.add(timer);
    return;
  }
  response.end(`<!doctype html><title>Orders</title><body>
<div aria-busy="true" hidden>Hidden loading widget</div>
<main aria-busy="true"><h1>All sales orders</h1>
<div class="orders-grid" role="grid">No orders</div></main>
<script>
window.formLoads = 0;
fetch('/form').then(response => response.text()).then(html => {
  document.querySelector('main').innerHTML = html;
  document.querySelector('main').setAttribute('aria-busy', 'false');
  window.formLoads++;
});
</script></body>`);
});

try {
  cpSync(join(process.cwd(), "dist"), extensionDir, { recursive: true });
  const manifestPath = join(extensionDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.permissions = manifest.permissions.filter(permission => permission !== "nativeMessaging");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(extensionDir, "driver.html"), "<!doctype html><title>Readiness driver</title><body>Driver</body>");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  browser = await puppeteer.launch({
    headless: true,
    enableExtensions: [extensionDir],
    userDataDir: join(scratch, "profile"),
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const workerTarget = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"));
  const extensionId = new URL(workerTarget.url()).host;
  const driver = await browser.newPage();
  driver.setDefaultTimeout(delayMs + 30_000);
  await driver.goto(`chrome-extension://${extensionId}/driver.html`);
  const worker = await workerTarget.worker();
  const tab = await worker.evaluate(url => chrome.tabs.create({ url, active: false }), url);
  const page = await browser.waitForTarget(target => target.url() === url).then(target => target.page());
  await page.waitForSelector(".orders-grid");
  const call = message => driver.evaluate(message => chrome.runtime.sendMessage(message), { tabId: tab.id, ...message });
  const expect = { selector: ".orders-grid", emptyText: "No orders" };

  const initial = await call({ type: "PAGE_READINESS", expect });
  assert.equal(initial.readyState, "complete");
  assert.equal(initial.snapshot.selector.matched, true);
  assert.equal(initial.snapshot.visibleBusyRegions, 1, "Hidden busy regions must be ignored");
  assert.equal(initial.state, "loading", JSON.stringify(initial));
  const timedOut = await call({ type: "WAIT_FOR_READY", expect, timeout: 100, interval: 50 });
  // The extension-page runtime listener exposes errors as text; native-host
  // callers also receive the typed codes covered by readiness handler tests.
  assert.match(timedOut.error, /Page did not become ready within 100ms/);
  const ready = await call({ type: "WAIT_FOR_READY", expect, timeout: 600_000, interval: 200 });
  assert.equal(ready.state, "ready", JSON.stringify(ready));
  assert.equal(ready.timeout, 600_000, "The explicit debugger budget was silently capped");
  assert.ok(ready.polls > 1, JSON.stringify(ready));
  assert.equal(formRequests, 1, "Readiness waiting must not replay navigation or server calls");
  assert.equal(await page.evaluate(() => window.formLoads), 1);
  console.log(`PASS: stale grid and empty text remained loading until the ${delayMs}ms server-held response completed; 600000ms budget honored`);

  // A blocked renderer must not wedge the worker's read-only readiness probe.
  await page.evaluate(() => {
    setTimeout(() => {
      const end = performance.now() + 3500;
      while (performance.now() < end) { /* deliberate test-only renderer stall */ }
    }, 0);
  });
  const started = Date.now();
  const blocked = await call({ type: "PAGE_READINESS" });
  assert.equal(blocked.state, "loading", JSON.stringify(blocked));
  assert.ok(blocked.evidence.some(line => line.includes("did not respond within 2000ms")));
  assert.ok(Date.now() - started < 3200, "An unresponsive probe exceeded its bounded deadline");
  const recovered = await call({ type: "WAIT_FOR_READY", expect: { selector: ".orders-grid" }, timeout: 10_000 });
  assert.equal(recovered.state, "ready", JSON.stringify(recovered));
  console.log("PASS: stalled renderer probe returned loading within 2s and the next read-only wait recovered");

  await page.evaluate(() => {
    document.body.innerHTML = "<h1>Session ended</h1><p>There was no activity for a while so we closed the session.</p><button>Start new session</button>";
  });
  const expired = await call({ type: "WAIT_FOR_READY", expect, timeout: 600_000 });
  assert.match(expired.error, /Page is not ready: login.*session ended or expired/);
  assert.equal((await worker.evaluate(tabId => chrome.tabs.get(tabId), tab.id)).active, false);
  console.log("PASS: session expiry failed fast as login; target stayed in the background throughout");
} finally {
  if (browser) await browser.close();
  for (const timer of responseTimers) clearTimeout(timer);
  await new Promise(resolve => server.close(resolve));
  // The only recursive removal is this process's disposable test directory.
  if (!scratch.startsWith(join(tmpdir(), "surf-readiness-"))) throw new Error("Unexpected test directory");
  rmSync(scratch, { recursive: true, force: true });
}
