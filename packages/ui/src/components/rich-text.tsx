import type { RichBlock, RichInline, RichList } from '@vertex-digital/contracts';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

interface RichTextProps extends ComponentProps<'div'> {
  /** The nodes from `parseRichText` (S14 MD5): nothing else is ever rendered. */
  blocks: RichBlock[];
}

/**
 * A page body or an FAQ answer (S14 MD5): maps the parser's allowed nodes to elements with the
 * design-system typography. A server-compatible component: no state, no effects, no raw HTML.
 * Emphasis is a weight, never a slanted face (brand §9).
 */
function RichText({ blocks, className, ...props }: RichTextProps) {
  return (
    <div
      data-slot="rich-text"
      className={cn('flex flex-col gap-4 text-md text-foreground', className)}
      {...props}
    >
      {blocks.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the blocks are a fixed render of one source
        <Block key={index} block={block} />
      ))}
    </div>
  );
}

function Block({ block }: { block: RichBlock }) {
  switch (block.type) {
    case 'paragraph':
      return (
        <p>
          <Inlines nodes={block.children} />
        </p>
      );
    case 'heading':
      return block.level === 2 ? (
        <h2 id={block.id} className="mt-2 scroll-mt-24 text-xl font-semibold">
          <Inlines nodes={block.children} />
        </h2>
      ) : (
        <h3 id={block.id} className="mt-1 scroll-mt-24 text-lg font-semibold">
          <Inlines nodes={block.children} />
        </h3>
      );
    case 'list':
      return <List list={block} />;
    case 'quote':
      return (
        <blockquote className="flex flex-col gap-3 border-s-2 border-border ps-4 text-muted-foreground">
          {block.children.map((child, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the blocks are a fixed render of one source
            <Block key={index} block={child} />
          ))}
        </blockquote>
      );
  }
}

function List({ list }: { list: RichList }) {
  const items = list.items.map((item, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the items are a fixed render of one source
    <li key={index} className="ps-1">
      <Inlines nodes={item.children} />
      {item.list && <List list={item.list} />}
    </li>
  ));
  const className = 'flex flex-col gap-1.5 ps-6';
  return list.ordered ? (
    <ol className={cn(className, 'list-decimal')} start={list.start === 1 ? undefined : list.start}>
      {items}
    </ol>
  ) : (
    <ul className={cn(className, 'list-disc')}>{items}</ul>
  );
}

function Inlines({ nodes }: { nodes: RichInline[] }) {
  return nodes.map((node, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the nodes are a fixed render of one source
    <Inline key={index} node={node} />
  ));
}

function Inline({ node }: { node: RichInline }) {
  switch (node.type) {
    case 'text':
      return node.value;
    case 'break':
      return <br />;
    case 'strong':
      return (
        <strong className="font-semibold">
          <Inlines nodes={node.children} />
        </strong>
      );
    case 'emphasis':
      return (
        <em className="font-medium [font-style:normal]">
          <Inlines nodes={node.children} />
        </em>
      );
    case 'link':
      return (
        <a
          href={node.href}
          className="font-medium text-primary underline underline-offset-4 hover:no-underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Inlines nodes={node.children} />
        </a>
      );
  }
}

export { RichText, type RichTextProps };
