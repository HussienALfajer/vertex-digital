/**
 * Runs once when the store's server starts; the Node.js part lives in its own file, so the Edge
 * build never sees it.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./instrumentation-node');
}
