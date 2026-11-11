import { describe, expect, it, vi } from "vitest";
import { describeError, logUiError } from "./uiErrors";

const sent = vi.hoisted(() => vi.fn(async (_kind: string, _message: string) => {}));
vi.mock("../ipc", () => ({ api: { logUiError: sent } }));

describe("describeError", () => {
  it("keeps the message of an error with its stack", () => {
    const err = new Error("no such file");
    err.stack = "frame one\nframe two";
    expect(describeError(err)).toBe("Error: no such file\nframe one\nframe two");
  });

  it("describes what a rejection can carry", () => {
    expect(describeError("plain text")).toBe("plain text");
    expect(describeError({ code: 7 })).toBe('{"code":7}');
    expect(describeError(undefined)).toBe("undefined");
    const loop: { self?: unknown } = {};
    loop.self = loop;
    expect(describeError(loop)).toBe("[object Object]");
  });
});

describe("logUiError", () => {
  it("stops sending after a limit, survives a failed send, and starts again a minute later", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    sent.mockRejectedValueOnce(new Error("window closing"));
    for (let i = 0; i < 100; i++) logUiError("error", `failure ${i}`);
    await Promise.resolve();
    expect(sent).toHaveBeenCalledTimes(20);
    expect(sent).toHaveBeenLastCalledWith("error", "failure 19");

    vi.setSystemTime(1_000_000 + 59_000);
    logUiError("error", "still limited");
    expect(sent).toHaveBeenCalledTimes(20);

    vi.setSystemTime(1_000_000 + 60_000);
    logUiError("error", "the real crash");
    expect(sent).toHaveBeenLastCalledWith("error", "the real crash");
    vi.useRealTimers();
  });
});
