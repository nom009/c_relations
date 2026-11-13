import { describe, it, expect, vi } from "vitest";
import { retryWhileWaking, setServerWakingListener } from "../../src/storage/coldStart";
import { ApiUnavailableError, isServerWaking } from "../../src/storage/ApiRepository";

const fakeClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

describe("isServerWaking", () => {
  it("only 5xx responses count; offline and 4xx do not", () => {
    expect(isServerWaking(new ApiUnavailableError("x", 500))).toBe(true);
    expect(isServerWaking(new ApiUnavailableError("x", 503))).toBe(true);
    expect(isServerWaking(new ApiUnavailableError("x", null))).toBe(false);
    expect(isServerWaking(new Error("x"))).toBe(false);
  });
});

describe("retryWhileWaking", () => {
  it("retries until the server answers and notifies once", async () => {
    const onWake = vi.fn();
    setServerWakingListener(onWake);
    let calls = 0;
    const r = await retryWhileWaking(
      async () => {
        if (++calls < 4) throw new ApiUnavailableError("x", 500);
        return "ok";
      },
      isServerWaking,
      fakeClock(),
    );
    setServerWakingListener(null);
    expect(r).toBe("ok");
    expect(calls).toBe(4);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the server is unreachable", async () => {
    let calls = 0;
    const err = new ApiUnavailableError("offline", null);
    await expect(
      retryWhileWaking(
        async () => {
          calls++;
          throw err;
        },
        isServerWaking,
        fakeClock(),
      ),
    ).rejects.toBe(err);
    expect(calls).toBe(1);
  });

  it("gives up once the time budget is spent", async () => {
    let calls = 0;
    const err = new ApiUnavailableError("down", 502);
    await expect(
      retryWhileWaking(
        async () => {
          calls++;
          throw err;
        },
        isServerWaking,
        { ...fakeClock(), budgetMs: 10_000, delaysMs: [4000] },
      ),
    ).rejects.toBe(err);
    expect(calls).toBe(3);
  });
});
