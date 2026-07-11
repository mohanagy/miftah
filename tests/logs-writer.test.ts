import { PassThrough, Writable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createStdoutWriter } from "../src/cli/logs.js";

describe("stdout writer", () => {
  it("waits for a real writable drain and cleans up listeners", async () => {
    const target = new PassThrough({ highWaterMark: 1 });
    const write = createStdoutWriter(target)("x");
    let settled = false;
    void write.then(() => {
      settled = true;
    });

    await nextTurn();

    expect(settled).toBe(false);
    expect(target.listenerCount("drain")).toBe(1);
    expect(target.listenerCount("error")).toBe(1);

    target.resume();

    await expect(write).resolves.toBeUndefined();
    expect(target.listenerCount("drain")).toBe(0);
    expect(target.listenerCount("error")).toBe(0);
  });

  it("rejects writable errors and cleans up listeners", async () => {
    const target = new PassThrough({ highWaterMark: 1 });
    const expected = new Error("stdout failed");
    const write = createStdoutWriter(target)("x");

    expect(target.listenerCount("drain")).toBe(1);
    expect(target.listenerCount("error")).toBe(1);

    target.destroy(expected);

    await expect(write).rejects.toBe(expected);
    expect(target.listenerCount("drain")).toBe(0);
    expect(target.listenerCount("error")).toBe(0);
  });

  it("propagates errors after a non-backpressured write", async () => {
    const expected = new Error("stdout failed after acceptance");
    const target = new Writable({
      write(_chunk, _encoding, callback) {
        queueMicrotask(() => callback(expected));
      }
    });
    const write = createStdoutWriter(target)("x");

    expect(target.listenerCount("drain")).toBe(1);
    expect(target.listenerCount("error")).toBe(1);

    await expect(write).rejects.toBe(expected);
    expect(target.listenerCount("drain")).toBe(0);
    expect(target.listenerCount("error")).toBe(0);
  });
});
