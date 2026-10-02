import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, resetChromeMock } from "../../mocks/chrome";

vi.mock("../../../src/native/port-manager", () => ({
  initNativeMessaging: vi.fn(),
  postToNativeHost: vi.fn(),
}));

async function load() {
  vi.resetModules();
  const chrome = createChromeMock();
  (globalThis as any).chrome = chrome;
  const { handleMessage } = await import("../../../src/service-worker/index");
  return { chrome, handleMessage };
}

describe("trusted input and page health", () => {
  beforeEach(() => resetChromeMock());
  afterEach(() => vi.useRealTimers());

  it("focuses the requested frame before clearing, typing, and submitting", async () => {
    const { chrome, handleMessage } = await load();
    chrome.tabs.sendMessage.mockResolvedValue({ success: true });
    await handleMessage(
      {
        type: "EXECUTE_TYPE",
        tabId: 42,
        frameId: 7,
        ref: "e3",
        text: "A 2!",
        clear: true,
        submit: true,
      },
      {},
    );
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ type: "FOCUS_ELEMENT", ref: "e3" }),
      { frameId: 7 },
    );
    const keys = chrome.debugger.sendCommand.mock.calls
      .filter((call) => call[1] === "Input.dispatchKeyEvent")
      .map((call) => call[2]);
    expect(keys[0].commands).toEqual(["selectAll"]);
    expect(keys[2].key).toBe("Backspace");
    expect(keys.at(-2).key).toBe("Enter");
    expect(chrome.debugger.sendCommand).toHaveBeenLastCalledWith(
      { tabId: 42 },
      "Emulation.setFocusEmulationEnabled",
      { enabled: false },
    );
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it("does not clear or type into another field when ref focus fails", async () => {
    const { chrome, handleMessage } = await load();
    chrome.tabs.sendMessage.mockResolvedValue({ error: "Stale ref" });
    await expect(
      handleMessage({ type: "EXECUTE_TYPE", tabId: 42, ref: "e3", text: "query", clear: true }, {}),
    ).rejects.toMatchObject({ code: "input_focus_failed", message: "Stale ref" });
    expect(
      chrome.debugger.sendCommand.mock.calls.some((call) => call[1].startsWith("Input.")),
    ).toBe(false);
    expect(chrome.debugger.sendCommand).toHaveBeenLastCalledWith(
      { tabId: 42 },
      "Emulation.setFocusEmulationEnabled",
      { enabled: false },
    );
  });

  it("submits a JS ref fill from that field", async () => {
    const { chrome, handleMessage } = await load();
    chrome.tabs.sendMessage.mockResolvedValue({ success: true });
    await handleMessage(
      { type: "FORM_FILL", tabId: 42, data: [{ ref: "e3", value: "query" }], submit: true },
      {},
    );
    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
      42,
      { type: "FOCUS_ELEMENT", ref: "e3" },
      { frameId: 0 },
    );
    expect(
      chrome.debugger.sendCommand.mock.calls.some(
        (call) => call[1] === "Input.dispatchKeyEvent" && call[2].key === "Enter",
      ),
    ).toBe(true);
  });

  it("reports both hung probe channels within 1.5 seconds", async () => {
    vi.useFakeTimers();
    const { chrome, handleMessage } = await load();
    chrome.tabs.get.mockResolvedValue({
      id: 42,
      windowId: 1,
      groupId: -1,
      active: false,
      url: "https://example.com",
    });
    chrome.tabs.sendMessage.mockReturnValue(new Promise(() => undefined));
    chrome.debugger.sendCommand.mockImplementation((_target, method) =>
      method === "Runtime.evaluate" ? new Promise(() => undefined) : Promise.resolve({}),
    );
    const health = handleMessage({ type: "PAGE_HEALTH", tabId: 42, frameId: 7 }, {});
    await vi.advanceTimersByTimeAsync(1500);
    await expect(health).resolves.toMatchObject({
      healthy: false,
      frameId: 7,
      contentScript: { responsive: false },
      runtime: { responsive: false },
      recoveryCommand: "surf reload --tab-id 42",
    });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a hung read even when overlay messages also hang, and allows a fresh read", async () => {
    vi.useFakeTimers();
    const { chrome, handleMessage } = await load();
    chrome.tabs.sendMessage.mockReturnValue(new Promise(() => undefined));
    const read = handleMessage({ type: "READ_PAGE", tabId: 42 }, {});
    const rejected = expect(read).rejects.toMatchObject({
      code: "content_script_timeout",
      details: { tabId: 42, frameId: 0, recoveryCommand: "surf page.health --tab-id 42" },
    });
    await vi.advanceTimersByTimeAsync(10550);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    chrome.tabs.sendMessage.mockResolvedValue({ pageContent: "Recovered" });
    const fresh = handleMessage({ type: "READ_PAGE", tabId: 42 }, {});
    await vi.advanceTimersByTimeAsync(50);
    await expect(fresh).resolves.toEqual({ pageContent: "Recovered" });
  });

  it("bounds a JS promise that never resolves and preserves structured timeout details", async () => {
    vi.useFakeTimers();
    const { chrome, handleMessage } = await load();
    chrome.debugger.sendCommand.mockImplementation((_target, method, params) =>
      method === "Runtime.evaluate" && !params.expression.includes("if(!window.piHelpers)")
        ? new Promise(() => undefined)
        : Promise.resolve({}),
    );
    const execution = handleMessage(
      { type: "EXECUTE_JAVASCRIPT", tabId: 42, code: "return new Promise(() => {});" },
      {},
    );
    const rejected = expect(execution).rejects.toMatchObject({
      code: "cdp_timeout",
      details: { tabId: 42, timeoutMs: 15000 },
    });
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not execute a script after its runtime setup exceeded the deadline", async () => {
    vi.useFakeTimers();
    const { chrome, handleMessage } = await load();
    let releaseRuntime: (value: object) => void = () => undefined;
    chrome.debugger.sendCommand.mockImplementation((_target, method) => {
      if (method === "Runtime.enable") {
        return new Promise((resolve) => {
          releaseRuntime = resolve;
        });
      }
      return Promise.resolve({});
    });
    const execution = handleMessage(
      { type: "EXECUTE_JAVASCRIPT", tabId: 42, code: "window.sideEffect = true;" },
      {},
    );
    const rejected = expect(execution).rejects.toMatchObject({ code: "cdp_timeout" });
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    releaseRuntime({});
    await vi.advanceTimersByTimeAsync(0);
    expect(
      chrome.debugger.sendCommand.mock.calls.some((call) => call[1] === "Runtime.evaluate"),
    ).toBe(false);
  });
});
