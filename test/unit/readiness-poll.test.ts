import { describe, expect, it } from "vitest";
import {
  clampReadinessBudget,
  DEFAULT_READINESS_INTERVAL_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  MAX_READINESS_TIMEOUT_MS,
  MIN_READINESS_INTERVAL_MS,
  pollReadiness,
  type ReadinessProbeResult,
  type ReadinessState,
} from "../../src/utils/readiness-poll";

function fakeClock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
    advance: (ms: number) => {
      time += ms;
    },
    sleeps,
  };
}

function sequence(states: ReadinessState[]): () => Promise<ReadinessProbeResult> {
  let index = 0;
  return async () => {
    const state = states[Math.min(index, states.length - 1)];
    index += 1;
    return { state, evidence: [`probe ${index}`] };
  };
}

describe("clampReadinessBudget", () => {
  it("applies defaults for missing or invalid input", () => {
    expect(clampReadinessBudget({})).toEqual({
      timeoutMs: DEFAULT_READINESS_TIMEOUT_MS,
      intervalMs: DEFAULT_READINESS_INTERVAL_MS,
    });
    expect(clampReadinessBudget({ timeoutMs: "abc", intervalMs: -5 })).toEqual({
      timeoutMs: DEFAULT_READINESS_TIMEOUT_MS,
      intervalMs: DEFAULT_READINESS_INTERVAL_MS,
    });
  });

  it("caps the timeout, floors the interval and keeps the interval within the timeout", () => {
    expect(clampReadinessBudget({ timeoutMs: 10_000_000, intervalMs: 1 })).toEqual({
      timeoutMs: MAX_READINESS_TIMEOUT_MS,
      intervalMs: MIN_READINESS_INTERVAL_MS,
    });
    expect(clampReadinessBudget({ timeoutMs: 200, intervalMs: 5000 })).toEqual({
      timeoutMs: 200,
      intervalMs: 200,
    });
  });

  it("honors a ten-minute debugger budget", () => {
    expect(clampReadinessBudget({ timeoutMs: 600_000, intervalMs: 1000 })).toEqual({
      timeoutMs: 600_000,
      intervalMs: 1000,
    });
  });
});

describe("pollReadiness", () => {
  it("passes the remaining deadline to slow probes", async () => {
    const clock = fakeClock();
    const budgets: number[] = [];
    const outcome = await pollReadiness({
      timeoutMs: 600_000,
      intervalMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
      probe: async (remainingMs) => {
        budgets.push(remainingMs);
        clock.advance(130_000);
        return { state: budgets.length === 2 ? "ready" : "loading", evidence: [] };
      },
    });
    expect(outcome.kind).toBe("settled");
    expect(outcome.waitedMs).toBe(261_000);
    expect(budgets).toEqual([600_000, 469_000]);
  });
  it("keeps polling through loading and settles on ready", async () => {
    const clock = fakeClock();
    const outcome = await pollReadiness({
      timeoutMs: 5000,
      intervalMs: 400,
      probe: sequence(["loading", "loading", "ready"]),
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(outcome.kind).toBe("settled");
    expect(outcome.result.state).toBe("ready");
    expect(outcome.polls).toBe(3);
    expect(clock.sleeps).toEqual([400, 400]);
    expect(outcome.waitedMs).toBe(800);
  });

  it("treats empty as settled", async () => {
    const clock = fakeClock();
    const outcome = await pollReadiness({
      timeoutMs: 5000,
      intervalMs: 100,
      probe: sequence(["empty"]),
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(outcome.kind).toBe("settled");
    expect(outcome.polls).toBe(1);
  });

  it("stops on a negative state without waiting for the timeout", async () => {
    const clock = fakeClock();
    const outcome = await pollReadiness({
      timeoutMs: 60_000,
      intervalMs: 400,
      probe: sequence(["loading", "login"]),
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(outcome.kind).toBe("negative");
    expect(outcome.result.state).toBe("login");
    expect(outcome.polls).toBe(2);
  });

  it("returns accepted when the negative state is in the accept list", async () => {
    const clock = fakeClock();
    const outcome = await pollReadiness({
      timeoutMs: 1000,
      intervalMs: 100,
      accept: ["login"],
      probe: sequence(["login"]),
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(outcome.kind).toBe("accepted");
  });

  it("times out with the last loading result and never sleeps past the deadline", async () => {
    const clock = fakeClock();
    const seen: number[] = [];
    const outcome = await pollReadiness({
      timeoutMs: 1000,
      intervalMs: 400,
      probe: sequence(["loading"]),
      sleep: clock.sleep,
      now: clock.now,
      onPoll: (_result, poll) => seen.push(poll),
    });
    expect(outcome.kind).toBe("timeout");
    expect(outcome.result.state).toBe("loading");
    expect(clock.sleeps).toEqual([400, 400, 200]);
    expect(outcome.polls).toBe(4);
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(outcome.waitedMs).toBe(1000);
  });

  it("always makes at least one probe even with a spent budget", async () => {
    const clock = fakeClock();
    const outcome = await pollReadiness({
      timeoutMs: 0,
      intervalMs: 50,
      probe: sequence(["loading"]),
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(outcome.kind).toBe("timeout");
    expect(outcome.polls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });
});
