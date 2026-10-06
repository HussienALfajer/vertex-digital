import { fileURLToPath } from 'node:url';

export const rootEnvFile = fileURLToPath(new URL('../../../.env', import.meta.url));

/** Loads the repository's root .env file if it exists. Variables already set in the environment win. */
export function loadRootEnv(): void {
  try {
    process.loadEnvFile(rootEnvFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
