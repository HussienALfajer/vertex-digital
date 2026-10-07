import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * Development only: serves the licensed Madani files from the git-ignored brand/fonts/private/.
 * In production nginx serves /fonts/madani/ from outside the repository and never reaches here.
 */
export async function GET(_request: Request, { params }: RouteContext<'/fonts/madani/[file]'>) {
  const { file } = await params;
  if (process.env.NODE_ENV === 'production' || !file.endsWith('.woff2')) {
    return new Response(null, { status: 404 });
  }
  const dir = join(process.cwd(), '../../brand/fonts/private');
  try {
    const body = await readFile(join(dir, basename(file)));
    return new Response(body, { headers: { 'content-type': 'font/woff2' } });
  } catch {
    return new Response(null, { status: 404 });
  }
}
