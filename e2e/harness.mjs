// Shared by the E2E test and scripts/screenshots.mjs: serves the UI with vite and drives it in headless Chrome over CDP.
// Chrome comes from $CHROME, else the usual install paths.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

const freePort = () =>
  new Promise((ok) => {
    const s = netServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts vite + Chrome; always call close(), even when launch() throws partway (it cleans up itself then). */
export async function launch() {
  const chromePath = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((p) => p && existsSync(p));
  if (!chromePath) throw new Error("Chrome not found: set CHROME to its path");

  const server = await createServer({ server: { port: await freePort(), strictPort: true, host: "127.0.0.1" }, logLevel: "error" });
  await server.listen();
  const base = server.resolvedUrls.local[0];
  const profile = mkdtempSync(join(tmpdir(), "wifisight-e2e-"));
  let chrome, ws;

  async function close() {
    ws?.close();
    if (chrome && chrome.exitCode === null) {
      // the profile can only go once Chrome has stopped writing to it
      const gone = new Promise((ok) => (chrome.once("exit", ok), setTimeout(ok, 5000)));
      chrome.kill();
      await gone;
    }
    await server.close();
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      // Chrome's helper processes on Linux can outlive it and keep writing; a leftover temp dir isn't a failure
      console.warn(`could not remove ${profile}: ${e.message}`);
    }
  }

  try {
    chrome = spawn(chromePath, [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--window-size=1440,900",
      "about:blank",
    ]);
    const port = await new Promise((ok, ng) => {
      let err = "";
      const timer = setTimeout(() => ng(new Error(`Chrome printed no DevTools address in 30 s: ${err}`)), 30000);
      chrome.stderr.on("data", (d) => {
        err += d;
        const m = err.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
        if (m) clearTimeout(timer), ok(m[1]);
      });
      chrome.on("exit", (code) => ng(new Error(`Chrome exited (${code}): ${err}`)));
    });

    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, ng) => ((ws.onopen = ok), (ws.onerror = ng)));
  } catch (e) {
    await close();
    throw e;
  }

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.ng(new Error(JSON.stringify(msg.error))) : p.ok(msg.result);
  };
  const send = (method, params = {}) =>
    new Promise((ok, ng) => {
      const id = ++seq;
      const timer = setTimeout(() => (pending.delete(id), ng(new Error(`CDP ${method}: no answer in 15 s`))), 15000);
      pending.set(id, { ok: (v) => (clearTimeout(timer), ok(v)), ng: (e) => (clearTimeout(timer), ng(e)) });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  async function waitFor(expr, ms = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await ev(expr)) return;
      await sleep(40);
    }
    throw new Error(`timeout waiting for: ${expr}`);
  }
  async function click({ x, y }) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }

  return { base, send, ev, waitFor, click, close };
}
