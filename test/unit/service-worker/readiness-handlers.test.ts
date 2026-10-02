import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, resetChromeMock } from "../../mocks/chrome";

vi.mock("../../../src/native/port-manager", () => ({
  initNativeMessaging: vi.fn(),
  postToNativeHost: vi.fn(),
}));

async function loadHandleMessage() {
  vi.resetModules();
  (globalThis as any).chrome = createChromeMock();
  const mod = await import("../../../src/service-worker/index");
  return mod.handleMessage;
}

function report(state: string, extra: Record<string, unknown> = {}) {
  return {
    state,
    evidence: [`${state} evidence`],
    href: "https://example.com/page",
    title: "Page",
    readyState: "complete",
    ...extra,
  };
}

describe("readiness handlers", () => {
  beforeEach(() => {
    resetChromeMock();
  });

  afterEach(() => vi.useRealTimers());

  it("bounds an unresponsive single probe and reports loading", async () => {
    const handleMessage = await loadHandleMessage();
    const chrome = (globalThis as any).chrome;
    chrome.tabs.get.mockResolvedValue({ id: 5, url: "https://example.com/", status: "complete" });
    chrome.tabs.sendMessage.mockImplementation(
      () =>
        new Promise(() => {
          /* Deliberately never responds. */
        }),
    );
    vi.useFakeTimers();
    const pending = handleMessage({ type: "PAGE_READINESS", tabId: 5 }, {});
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toMatchObject({
      state: "loading",
      evidence: [expect.stringContaining("did not respond within 2000ms")],
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers from an unresponsive probe without replaying an action", async () => {
    const handleMessage = await loadHandleMessage();
    const chrome = (globalThis as any).chrome;
    chrome.tabs.get.mockResolvedValue({ id: 5, url: "https://example.com/", status: "complete" });
    let finishLate: (value: unknown) => void = () => {
      /* Replaced by the deferred probe's resolver. */
    };
    chrome.tabs.sendMessage
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishLate = resolve;
          }),
      )
      .mockResolvedValueOnce(report("ready"));
    vi.useFakeTimers();
    const pending = handleMessage({ type: "WAIT_FOR_READY", tabId: 5, timeout: 600000 }, {});
    await vi.advanceTimersByTimeAsync(2400);
    await expect(pending).resolves.toMatchObject({
      state: "ready",
      polls: 2,
      timeout: 600000,
      waited: 2400,
    });
    finishLate(report("login"));
    await Promise.resolve();
    expect(chrome.tabs.sendMessage.mock.calls.map((call: any[]) => call[1].type)).toEqual([
      "PAGE_READINESS",
      "PAGE_READINESS",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a hung probe cannot exceed the caller's short readiness deadline", async () => {
    const handleMessage = await loadHandleMessage();
    const chrome = (globalThis as any).chrome;
    chrome.tabs.get.mockResolvedValue({ id: 5, url: "https://example.com/", status: "complete" });
    chrome.tabs.sendMessage.mockImplementation(
      () =>
        new Promise(() => {
          /* Deliberately never responds. */
        }),
    );
    vi.useFakeTimers();
    const pending = handleMessage({ type: "WAIT_FOR_READY", tabId: 5, timeout: 120 }, {});
    const assertion = expect(pending).rejects.toMatchObject({
      code: "page_timeout",
      details: expect.objectContaining({ waited: 120, polls: 1, state: "loading" }),
    });
    await vi.advanceTimersByTimeAsync(120);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("PAGE_READINESS forwards expectations to the content script and adds the tab status", async () => {
    const handleMessage = await loadHandleMessage();
    const chrome = (globalThis as any).chrome;
    chrome.tabs.get.mockResolvedValue({
      id: 5,
      url: "https://example.com/page",
      status: "complete",
    });
    chrome.tabs.sendMessage.mockResolvedValue(report("ready"));

    const result = await handleMessage(
      {
        type: "PAGE_READINESS",
        tabId: 5,
        expect: { selector: ".x", urlPrefix: "https://example.com/", bogus: 1, text: "" },
      },
      {},
    );

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      5,
      { type: "PAGE_READINESS", expect: { selector: ".x", urlPrefix: "https://example.com/" } },
      { frameId: 0 },
    );
    expect(result).toEqual({ ...report("ready"), tabStatus: "complete" });
  });

  it("PAGE_READINESS reports loading for a blank tab and error for restricted pages", async () => {
    const handleMessage = await loadHandleMessage();
    const chrome = (globalThis as any).chrome;

    chrome.tabs.get.mockResolvedValue({ id: 5, url: "about:blank", status: "loading" });
    const blank = await handleMessage({ type: "PAGE_READINESS", tabId: 5 }, {});
    expect(blank.state).toBe("loading");
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();

    chrome.tabs.get.mockResolvedValue({ id: 5, url: "chrome://settings/", status: "complete" });
    const restricted = await handleMessage({ type: "PAGE_READINESS", tabId: 5 }, {});
    expect(restricted.state).toBe("error");
    expect(restricted.evidence[0]).toContain("chrome://settings/");
  });

  it("PAGE_READINESS treats an unreachable content script as loading", async () => {
    const handleMessage = await loadHandleMessage();
    const chrome = (globalThis as any).chrome;
    chrome.tabs.get.mockResolvedValue({ id: 5, url: "https://example.com/", status: "loading" });
    chrome.tabs.sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));

    const result = await handleMessage({ type: "PAGE_READINESS", tabId: 5 }, {});
    expect(result.state).toBe("loading");
    expect(result.evidence[0]).toContain("content script unreachable");
    expect(result.tabStatus).toBe("loading");
  });

  it("PAGE_READINESS does not accept a stale report during pending navigation", async () => {
    const handleMessage = await loadHandleMessage();
    const chrome = (globalThis as any).chrome;
    chrome.tabs.get.mockResolvedValue({
      id: 5,
      url: "https://example.com/old",
      pendingUrl: "https://example.com/new",
      status: "loading",
    });
    chrome.tabs.sendMessage.mockResolvedValue(report("ready", { href: "https://example.com/old" }));

    const result = await handleMessage({ type: "PAGE_READINESS", tabId: 5 }, {});
    expect(result).toEqual({
      state: "loading",
      evidence: [
        "navigation to https://example.com/new pending; report is from https://example.com/old",
      ],
      href: "https://example.com/old",
      tabStatus: "loading",
    });
  });

  it("reports invalid CSS selectors as deterministic caller errors", async () => {
    const handleMessage = await loadHandleMessage();
    const chrome = (globalThis as any).chrome;
    chrome.tabs.get.mockResolvedValue({ id: 5, url: "https://example.com/", status: "complete" });
    chrome.tabs.sendMessage.mockResolvedValue({
      code: "invalid_selector",
      error: 'Invalid CSS selector "[": invalid selector',
    });

    await expect(
      handleMessage({ type: "WAIT_FOR_READY", tabId: 5, expect: { selector: "[" } }, {}),
    ).rejects.toMatchObject({
      code: "invalid_selector",
      message: expect.stringContaining('Invalid CSS selector "["'),
      details: { selector: "[", tabId: 5 },
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("WAIT_FOR_READY polls until the page is ready", async () => {
    const handleMessage = await loadHandleMessage();
    const chrome = (globalThis as any).chrome;
    chrome.tabs.get.mockResolvedValue({
      id: 5,
      url: "https://example.com/page",
      status: "complete",
    });
    chrome.tabs.sendMessage
      .mockResolvedValueOnce(report("loading"))
      .mockResolvedValueOnce(report("loading"))
      .mockResolvedValue(report("ready"));

    const result = await handleMessage(
      { type: "WAIT_FOR_READY", tabId: 5, timeout: 2000, interval: 10 },
      {},
    );

    expect(result.success).toBeUndefined();
    expect(result.state).toBe("ready");
    expect(result.accepted).toBe(false);
    expect(result.polls).toBe(3);
    expect(result.interval).toBe(50);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(3);
  });

  it("WAIT_FOR_READY fails fast with a typed code on a login bounce", async () => {
    const handleMessage = await loadHandleMessage();
    const chrome = (globalThis as any).chrome;
    chrome.tabs.get.mockResolvedValue({
      id: 5,
      url: "https://example.com/login",
      status: "complete",
    });
    chrome.tabs.sendMessage.mockResolvedValue(
      report("login", { href: "https://example.com/login" }),
    );

    const promise = handleMessage({ type: "WAIT_FOR_READY", tabId: 5, timeout: 5000 }, {});
    await expect(promise).rejects.toMatchObject({
      code: "page_login",
      message: expect.stringContaining("login at https://example.com/login (login evidence)"),
      details: expect.objectContaining({ state: "login", polls: 1, tabId: 5 }),
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("WAIT_FOR_READY returns an accepted negative state", async () => {
    const handleMessage = await loadHandleMessage();
    const chrome = (globalThis as any).chrome;
    chrome.tabs.get.mockResolvedValue({ id: 5, url: "https://example.com/", status: "complete" });
    chrome.tabs.sendMessage.mockResolvedValue(report("challenge"));

    const result = await handleMessage(
      { type: "WAIT_FOR_READY", tabId: 5, accept: "challenge,login" },
      {},
    );
    expect(result).toMatchObject({ accepted: true, state: "challenge" });
    expect(result.success).toBeUndefined();
  });

  it("WAIT_FOR_READY accepts only negative states before polling", async () => {
    const handleMessage = await loadHandleMessage();
    const chrome = (globalThis as any).chrome;
    for (const state of ["blocked", "ready", "empty", "loading"]) {
      await expect(
        handleMessage({ type: "WAIT_FOR_READY", tabId: 5, accept: state }, {}),
      ).rejects.toThrow(/Invalid --accept state/);
    }
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("WAIT_FOR_READY times out with page_timeout and the last state", async () => {
    const handleMessage = await loadHandleMessage();
    const chrome = (globalThis as any).chrome;
    chrome.tabs.get.mockResolvedValue({ id: 5, url: "https://example.com/", status: "loading" });
    chrome.tabs.sendMessage.mockResolvedValue(report("loading"));

    await expect(
      handleMessage({ type: "WAIT_FOR_READY", tabId: 5, timeout: 120, interval: 50 }, {}),
    ).rejects.toMatchObject({
      code: "page_timeout",
      message: expect.stringContaining("did not become ready within 120ms"),
      details: expect.objectContaining({ state: "loading" }),
    });
  });
});
