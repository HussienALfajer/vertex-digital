import type { Instrumentation } from 'next';

/**
 * Runs once when the store's server starts; the Node.js part lives in its own file, so the Edge
 * build never sees it.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./instrumentation-node');
}

/** Every error the server meets while rendering or routing, to Sentry (audit A10-18). */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { reportError } = await import('./lib/report-error');
  await reportError(error, request, context);
};
