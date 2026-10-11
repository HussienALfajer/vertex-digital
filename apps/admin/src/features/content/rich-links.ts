import type { RichBlock, RichInline } from '@vertex-digital/contracts';

/** Every link target of a parsed body, in order, each once. */
export function linkTargets(blocks: RichBlock[]): string[] {
  const found = new Set<string>();
  const inline = (nodes: RichInline[]) => {
    for (const node of nodes) {
      if (node.type === 'link') found.add(node.href);
      if ('children' in node) inline(node.children);
    }
  };
  const block = (nodes: RichBlock[]) => {
    for (const node of nodes) {
      if (node.type === 'quote') block(node.children);
      else if (node.type === 'list') {
        for (const item of node.items) {
          inline(item.children);
          if (item.list) block([item.list]);
        }
      } else inline(node.children);
    }
  };
  block(blocks);
  return [...found];
}

/**
 * S14 edge case 20: the targets that point at one of the four pages or `/faq` while it is not
 * published (the store answers 404 there until then). `published` holds the paths that are.
 */
export function unpublishedTargets(targets: string[], published: ReadonlySet<string>): string[] {
  const watched = new Set(['/terms', '/privacy', '/refund', '/about', '/faq']);
  return targets.filter((target) => {
    const path = target.split('#')[0]?.replace(/\/+$/, '') ?? '';
    return watched.has(path) && !published.has(path);
  });
}
