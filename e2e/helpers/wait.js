export async function waitForCondition(fn, { timeout = 5000, interval = 100, message = 'Condition not met' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {
      // ignore and retry
    }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`${message} (timeout: ${timeout}ms)`);
}

export async function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
