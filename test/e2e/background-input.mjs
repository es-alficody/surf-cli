import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer";

// Exercise the packaged extension in a disposable profile, without installing
// a native host or changing the user's Chrome/native-messaging configuration.
const scratch = mkdtempSync(join(tmpdir(), "surf-background-input-"));
const extensionDir = join(scratch, "extension");
let browser;
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><head><title>Trusted input fixture</title>
<style>body { background: rgb(12,34,56); color: white; }</style></head><body>
<label>Search <input id="search" aria-label="Search" value="old value"></label><p id="result">Waiting</p>
<iframe src="/frame"></iframe>
<script>
window.model = ""; window.events = [];
const field = document.querySelector("#search");
field.addEventListener("input", event => {
  window.events.push({ type: event.type, trusted: event.isTrusted, focused: document.hasFocus() });
  if (event.isTrusted) window.model = field.value;
});
field.addEventListener("keydown", event => {
  window.events.push({ type: event.type, key: event.key, trusted: event.isTrusted });
  if (event.key === "Enter" && event.isTrusted) document.querySelector("#result").textContent = window.model;
});
// Avoid recursive frames.
if (location.pathname === "/frame") document.querySelector("iframe").remove();
</script></body></html>`);
});

try {
  cpSync(join(process.cwd(), "dist"), extensionDir, { recursive: true });
  const manifestPath = join(extensionDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.permissions = manifest.permissions.filter((permission) => permission !== "nativeMessaging");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(extensionDir, "driver.html"), "<!doctype html><title>Surf test driver</title><body style='background:red'>Foreground driver</body>");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  browser = await puppeteer.launch({
    headless: true,
    enableExtensions: [extensionDir],
    userDataDir: join(scratch, "profile"),
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const workerTarget = await browser.waitForTarget((target) => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"));
  const extensionId = new URL(workerTarget.url()).host;
  const driver = await browser.newPage();
  await driver.goto(`chrome-extension://${extensionId}/driver.html`);
  const worker = await workerTarget.worker();
  const tab = await worker.evaluate((url) => chrome.tabs.create({ url, active: false }), url);
  const page = await browser.waitForTarget((target) => target.url() === url).then((target) => target.page());
  await page.waitForSelector("#search");
  const call = (message) => driver.evaluate((message) => chrome.runtime.sendMessage(message), { tabId: tab.id, ...message });

  const read = await call({ type: "READ_PAGE", options: {} });
  const ref = read.pageContent.match(/textbox "Search" \[(e\d+)\]/)?.[1];
  assert.ok(ref, `Search ref missing: ${read.pageContent}`);
  // The same field ignores the existing DOM-write path.
  await call({ type: "FORM_INPUT", ref, value: "synthetic" });
  assert.equal(await page.evaluate(() => window.model), "");

  const expected = "Search A 12!? ø漢😀";
  const typed = await call({ type: "EXECUTE_TYPE", ref, text: expected, clear: true, submit: true });
  assert.equal(typed.success, true, JSON.stringify(typed));
  assert.deepEqual(await page.evaluate(() => ({ value: document.querySelector("#search").value, model: window.model, submitted: document.querySelector("#result").textContent })), { value: expected, model: expected, submitted: expected });
  const events = await page.evaluate(() => window.events);
  assert.ok(events.some((event) => event.type === "input" && event.trusted && event.focused));
  assert.ok(events.some((event) => event.key === "Enter" && event.trusted));

  const appended = await call({ type: "EXECUTE_TYPE", selector: "#search", text: " appended" });
  assert.equal(appended.success, true, JSON.stringify(appended));
  assert.equal(await page.evaluate(() => document.querySelector("#search").value), `${expected} appended`);
  const empty = await call({ type: "EXECUTE_TYPE", selector: "#search", text: "", clear: true });
  assert.equal(empty.success, true, JSON.stringify(empty));
  assert.equal(await page.evaluate(() => window.model), "");

  const frames = await worker.evaluate((tabId) => chrome.webNavigation.getAllFrames({ tabId }), tab.id);
  const child = frames.find((frame) => frame.frameId !== 0);
  const childTyped = await call({ type: "EXECUTE_TYPE", frameId: child.frameId, selector: "#search", text: "iframe input", clear: true, submit: true });
  assert.equal(childTyped.success, true, JSON.stringify(childTyped));
  assert.equal(await page.frames().find((frame) => frame.url().endsWith("/frame")).evaluate(() => window.model), "iframe input");

  const shot = await call({ type: "EXECUTE_SCREENSHOT", strictTarget: true });
  assert.ok(shot.base64, JSON.stringify(shot));
  const pixel = await worker.evaluate(async (shot) => {
    const bytes = Uint8Array.from(atob(shot.base64), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const pixel = Array.from(context.getImageData(bitmap.width - 20, bitmap.height - 20, 1, 1).data);
    bitmap.close();
    return pixel;
  }, shot);
  assert.deepEqual(pixel, [12, 34, 56, 255], "Screenshot captured a different tab or a blank surface");
  const optional = await call({ type: "READ_PAGE", options: { includeScreenshot: true } });
  assert.ok(optional.screenshot?.base64, JSON.stringify(optional));
  const health = await call({ type: "PAGE_HEALTH" });
  assert.equal(health.healthy, true, JSON.stringify(health));
  assert.equal((await worker.evaluate((tabId) => chrome.tabs.get(tabId), tab.id)).active, false, "Surf activated the background tab");
  console.log("PASS: trusted background ref/selector/iframe typing, clear/submit/Unicode, correct background screenshots, page health; tab stayed inactive");
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  // scratch is created by this process under tmpdir, never a user-supplied path.
  rmSync(scratch, { recursive: true, force: true });
}
