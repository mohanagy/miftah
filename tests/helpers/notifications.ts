import { setTimeout as delay } from "node:timers/promises";
import { expect } from "vitest";

export const notificationSettleMs = 50;

export async function expectExactlyOneNotification(count: () => number): Promise<void> {
  await expect.poll(count).toBe(1);
  await delay(notificationSettleMs);
  expect(count()).toBe(1);
}
