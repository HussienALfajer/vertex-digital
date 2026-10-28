/**
 * A failed load of one of the build's own code files: after a deploy, a tab opened on the
 * previous release may ask for a chunk the server no longer has (audit A10-6, A10-7). Only a full
 * reload fetches the new release's pages; `router.refresh()` cannot.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'ChunkLoadError' ||
    /Loading (?:CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed/i.test(
      error.message,
    )
  );
}
