/**
 * Exponential backoff retry wrapper.
 *
 * Usage:
 *   import { withRetry } from './lib/retry.js';
 *   const data = await withRetry(() => fetchData(url), { retries: 3 });
 */

export async function withRetry(fn, opts = {}) {
  const { retries = 3, baseDelay = 1000, onRetry } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = baseDelay * 2 ** attempt;
        if (onRetry) onRetry(attempt + 1, err, delay);
        else console.error(`Retry ${attempt + 1}/${retries} in ${delay}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
