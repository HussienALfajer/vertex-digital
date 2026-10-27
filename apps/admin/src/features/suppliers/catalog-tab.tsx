import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  PRODUCT_KINDS,
  SUPPLIER_CATEGORY_STATES,
  type SupplierCategoryNode,
  type SupplierCategoryState,
  type SupplierDetail,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  FieldLabel,
  Input,
  Pagination,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@vertex-digital/ui';
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  EllipsisVerticalIcon,
  FolderTreeIcon,
  SearchIcon,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatSince } from '../../lib/format';
import { Thumbnail } from './category-thumbnail';
import { CategoryChangeDialog } from './game-supplier-links';
import { ImportCategorySheet } from './import-category-sheet';
import { LinkCategorySheet } from './link-category-sheet';
import type { CategorySearch } from './supplier-search';
import {
  CATEGORY_PAGE_SIZE,
  type CategoryChange,
  categoriesQuery,
  useCategoryChange,
} from './suppliers.queries';
import { TipButton } from './tip-button';

const ALL = 'all';

const STATE_TONES: Record<SupplierCategoryState, 'neutral' | 'success' | 'gold' | 'outline'> = {
  not_imported: 'outline',
  linked: 'success',
  new_packs: 'gold',
  ignored: 'neutral',
};

type Opened = { node: SupplierCategoryNode; dialog: 'import' | 'link' } | null;

/**
 * "الكتالوج" (S16 SC4–SC9): the supplier's category tree, roots first and children on expand
 * (100 a page, "المزيد" for the next), or with a search or a state every matching node with its
 * path; per node its thumbnail (IM1), counts, state, linked game and actions. A node's name opens
 * its own page with its packs (S18). Filters are in the URL.
 */
export function CatalogTab({
  supplier,
  search,
  onSearch,
}: {
  supplier: SupplierDetail;
  search: CategorySearch;
  onSearch: (next: CategorySearch) => void;
}) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState<Opened>(null);
  const change = useCategoryChange(supplier.code);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    node: SupplierCategoryNode;
    change: 'unlink' | 'ignore';
  } | null>(null);

  if (!supplier.capabilities.categories) {
    return <EmptyState icon={<FolderTreeIcon />} title={t('suppliers.catalog.unsupported')} />;
  }

  const flat = search.cq !== undefined || search.state !== undefined;

  async function act(node: SupplierCategoryNode, kind: CategoryChange) {
    setFailure(null);
    try {
      await change.mutateAsync({ categoryId: node.categoryId, change: kind });
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  const row = {
    supplier,
    busy: change.isPending,
    onOpen: (node: SupplierCategoryNode, dialog: 'import' | 'link') => setOpened({ node, dialog }),
    onChange: (node: SupplierCategoryNode, kind: CategoryChange) =>
      kind === 'unignore' ? act(node, kind) : setConfirming({ node, change: kind }),
  };

  return (
    <div className="flex flex-col gap-4">
      <Filters
        search={search}
        onSearch={(next) => onSearch({ ...search, ...next, cpage: undefined })}
        onClear={() => onSearch({})}
      />
      {failure && <FormAlert>{failure}</FormAlert>}
      {flat ? (
        <SearchResults
          search={search}
          row={row}
          onPage={(page) => onSearch({ ...search, cpage: page > 1 ? page : undefined })}
        />
      ) : (
        <ul className="flex flex-col rounded-lg border border-border bg-surface">
          <Level kind={search.kind} depth={0} row={row} root />
        </ul>
      )}
      <Sheet open={opened !== null} onOpenChange={(open) => !open && setOpened(null)}>
        {opened?.dialog === 'import' && (
          <ImportCategorySheet supplier={supplier} categoryId={opened.node.categoryId} />
        )}
        {opened?.dialog === 'link' && <LinkCategorySheet supplier={supplier} node={opened.node} />}
      </Sheet>
      {confirming && (
        <CategoryChangeDialog
          node={confirming.node}
          change={confirming.change}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

interface RowActions {
  supplier: SupplierDetail;
  busy: boolean;
  onOpen: (node: SupplierCategoryNode, dialog: 'import' | 'link') => void;
  onChange: (node: SupplierCategoryNode, change: CategoryChange) => void;
}

/** One level of the tree, its pages loaded one after another. */
function Level({
  parentId,
  kind,
  depth,
  row,
  root = false,
}: {
  parentId?: string;
  kind: CategorySearch['kind'];
  depth: number;
  row: RowActions;
  root?: boolean;
}) {
  const [pages, setPages] = useState(1);
  return (
    <>
      {Array.from({ length: pages }, (_, index) => (
        <LevelPage
          // biome-ignore lint/suspicious/noArrayIndexKey: pages only grow, in order.
          key={index}
          parentId={parentId}
          kind={kind}
          page={index + 1}
          depth={depth}
          row={row}
          root={root}
          last={index + 1 === pages}
          onMore={() => setPages((count) => count + 1)}
        />
      ))}
    </>
  );
}

function LevelPage({
  parentId,
  kind,
  page,
  depth,
  row,
  root,
  last,
  onMore,
}: {
  parentId?: string;
  kind: CategorySearch['kind'];
  page: number;
  depth: number;
  row: RowActions;
  root: boolean;
  last: boolean;
  onMore: () => void;
}) {
  const { t } = useTranslation();
  const level = useQuery(categoriesQuery(row.supplier.code, { parentId, kind, page }));
  if (level.isPending) {
    return (
      <li className="p-3" aria-hidden="true">
        <Skeleton className="h-12 w-full" />
      </li>
    );
  }
  if (level.isError) {
    return (
      <li className="flex flex-col items-start gap-2 p-3">
        <FormAlert>{errorMessage(t, level.error)}</FormAlert>
        <Button variant="outline" size="sm" onClick={() => level.refetch()}>
          {t('common.retry')}
        </Button>
      </li>
    );
  }
  if (root && page === 1 && level.data.total === 0) {
    return (
      <li>
        <EmptyState
          icon={<FolderTreeIcon />}
          title={kind ? t('suppliers.catalog.noMatch') : t('suppliers.catalog.empty')}
        />
      </li>
    );
  }
  const more = last && page * CATEGORY_PAGE_SIZE < level.data.total;
  return (
    <>
      {level.data.items.map((node) => (
        <TreeNode key={node.categoryId} node={node} kind={kind} depth={depth} row={row} />
      ))}
      {more && (
        <li className="border-t border-border p-2" style={{ paddingInlineStart: indent(depth) }}>
          <Button variant="ghost" size="sm" onClick={onMore}>
            {t('suppliers.catalog.more', {
              shown: page * CATEGORY_PAGE_SIZE,
              total: level.data.total,
            })}
          </Button>
        </li>
      )}
    </>
  );
}

const indent = (depth: number) => `${0.75 + depth * 1.5}rem`;

function TreeNode({
  node,
  kind,
  depth,
  row,
}: {
  node: SupplierCategoryNode;
  kind: CategorySearch['kind'];
  depth: number;
  row: RowActions;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <li className="border-t border-border first:border-t-0">
      <div className="flex items-start gap-2 p-3" style={{ paddingInlineStart: indent(depth) }}>
        {node.childCount > 0 ? (
          <TipButton
            aria-expanded={open}
            label={
              open
                ? t('suppliers.catalog.collapse', { name: node.name })
                : t('suppliers.catalog.expand', { name: node.name })
            }
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <ChevronDownIcon /> : <ChevronLeftIcon className="ltr:-scale-x-100" />}
          </TipButton>
        ) : (
          <span className="size-8 shrink-0" />
        )}
        <NodeLine node={node} row={row} />
      </div>
      {open && (
        <ul>
          <Level parentId={node.categoryId} kind={kind} depth={depth + 1} row={row} />
        </ul>
      )}
    </li>
  );
}

/** A search or state filter: matching nodes at any depth, with their path, paged. */
function SearchResults({
  search,
  row,
  onPage,
}: {
  search: CategorySearch;
  row: RowActions;
  onPage: (page: number) => void;
}) {
  const { t } = useTranslation();
  const page = search.cpage ?? 1;
  const results = useQuery(
    categoriesQuery(row.supplier.code, {
      q: search.cq,
      state: search.state,
      kind: search.kind,
      page,
    }),
  );
  if (results.isPending) return <Skeleton className="h-96 w-full" aria-hidden="true" />;
  if (results.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormAlert>{errorMessage(t, results.error)}</FormAlert>
        <Button variant="outline" onClick={() => results.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  if (results.data.items.length === 0) {
    return <EmptyState icon={<FolderTreeIcon />} title={t('suppliers.catalog.noMatch')} />;
  }
  return (
    <>
      <ul className="flex flex-col rounded-lg border border-border bg-surface">
        {results.data.items.map((node) => (
          <li key={node.categoryId} className="border-t border-border p-3 first:border-t-0">
            <NodeLine node={node} row={row} withPath />
          </li>
        ))}
      </ul>
      <Pagination
        page={page}
        pageCount={Math.max(1, Math.ceil(results.data.total / CATEGORY_PAGE_SIZE))}
        onPageChange={onPage}
        summary={t('suppliers.catalog.total', { total: results.data.total })}
        previousLabel={t('common.previous')}
        nextLabel={t('common.next')}
      />
    </>
  );
}

/** A node's thumbnail, name, counts, state, linked game and actions. */
function NodeLine({
  node,
  row,
  withPath = false,
}: {
  node: SupplierCategoryNode;
  row: RowActions;
  withPath?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const importable = node.game === null && node.state !== 'ignored' && !node.missingSince;
  const linkable = node.state !== 'ignored' && !node.missingSince;
  const page = {
    to: '/suppliers/$code/categories/$categoryId',
    params: { code: row.supplier.code, categoryId: node.categoryId },
  } as const;
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-start gap-3">
      <Thumbnail node={node} supplierCode={row.supplier.code} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Link {...page} className="text-start font-medium underline-offset-4 hover:underline">
          <bdi>{node.name}</bdi>
        </Link>
        {withPath && node.path.length > 0 && (
          <bdi className="text-xs text-muted-foreground">{node.path.join(' › ')}</bdi>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={STATE_TONES[node.state]}>
            {node.state === 'new_packs'
              ? t('suppliers.catalog.newPacks', { count: node.counts.newPacks })
              : t(`suppliers.catalog.states.${node.state}`)}
          </Badge>
          {node.missingSince && (
            <Badge tone="danger">
              {t('suppliers.catalog.missing', { since: formatSince(node.missingSince) })}
            </Badge>
          )}
          {node.kind && (
            <Badge tone={node.kind === 'code' ? 'gold' : 'info'}>
              {t(`catalog.products.kinds.${node.kind}`)}
            </Badge>
          )}
          {node.game && (
            <Link
              to="/catalog/games/$id"
              params={{ id: node.game.id }}
              search={{ tab: 'products' }}
              className="text-sm underline-offset-4 hover:underline"
            >
              {node.linkedHere
                ? t('suppliers.catalog.linkedTo', { game: node.game.nameAr })
                : t('suppliers.catalog.linkedAbove', { game: node.game.nameAr })}
            </Link>
          )}
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">
          {t('suppliers.catalog.counts', {
            products: node.productCount ?? '—',
            inStock: node.inStockCount ?? '—',
            mapped: node.counts.mapped,
            unmapped: node.counts.unmapped,
            ignored: node.counts.ignored,
            unsupported: node.counts.unsupported,
          })}
        </p>
        {node.note && (
          // S19: the supplier's own text (FazerCards' region and delivery note), as text.
          <p
            dir="auto"
            className="line-clamp-2 whitespace-pre-line text-xs text-muted-foreground"
            title={node.note}
          >
            {node.note}
          </p>
        )}
      </div>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={row.busy}
                    aria-label={t('suppliers.catalog.actions', { name: node.name })}
                  />
                }
              />
            }
          >
            <EllipsisVerticalIcon />
          </TooltipTrigger>
          <TooltipContent>{t('suppliers.catalog.actions', { name: node.name })}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent>
          {importable && (
            <DropdownMenuItem onClick={() => row.onOpen(node, 'import')}>
              {t('suppliers.catalog.import')}
            </DropdownMenuItem>
          )}
          {linkable && (
            <DropdownMenuItem onClick={() => row.onOpen(node, 'link')}>
              {t('suppliers.catalog.link')}
            </DropdownMenuItem>
          )}
          {node.ignoredAt ? (
            <DropdownMenuItem onClick={() => row.onChange(node, 'unignore')}>
              {t('suppliers.catalog.unignore')}
            </DropdownMenuItem>
          ) : (
            !node.linkedHere && (
              <DropdownMenuItem onClick={() => row.onChange(node, 'ignore')}>
                {t('suppliers.catalog.ignore')}
              </DropdownMenuItem>
            )
          )}
          {node.linkedHere && (
            <DropdownMenuItem variant="destructive" onClick={() => row.onChange(node, 'unlink')}>
              {t('suppliers.catalog.unlink')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => navigate(page)}>
            {t('suppliers.catalog.showPacks')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function Filters({
  search,
  onSearch,
  onClear,
}: {
  search: CategorySearch;
  onSearch: (next: CategorySearch) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState(search.cq ?? '');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = q.trim();
    onSearch({ cq: value.length >= 1 && value.length <= 100 ? value : undefined });
  }

  const states = [
    { value: ALL, label: t('suppliers.catalog.filters.all') },
    ...SUPPLIER_CATEGORY_STATES.map((value) => ({
      value,
      label: t(`suppliers.catalog.states.${value}`),
    })),
  ];
  const kinds = [
    { value: ALL, label: t('suppliers.catalog.filters.all') },
    ...PRODUCT_KINDS.map((value) => ({ value, label: t(`catalog.products.kinds.${value}`) })),
  ];

  return (
    <div className="flex flex-wrap items-end gap-3">
      <form className="flex items-end gap-2" onSubmit={submit}>
        <Field className="w-64">
          <FieldLabel>{t('suppliers.catalog.search')}</FieldLabel>
          <Input
            name="cq"
            value={q}
            placeholder={t('suppliers.catalog.searchPlaceholder')}
            onChange={(event) => setQ(event.target.value)}
          />
        </Field>
        <TipButton
          type="submit"
          variant="outline"
          size="icon"
          label={t('suppliers.catalog.searchSubmit')}
        >
          <SearchIcon />
        </TipButton>
      </form>
      <Field className="w-full sm:w-44">
        <FieldLabel>{t('suppliers.catalog.filters.state')}</FieldLabel>
        <Select
          items={states}
          value={search.state ?? ALL}
          onValueChange={(next) =>
            onSearch({
              state: next === ALL ? undefined : (next as SupplierCategoryState),
            })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {states.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field className="w-full sm:w-40">
        <FieldLabel>{t('suppliers.catalog.filters.kind')}</FieldLabel>
        <Select
          items={kinds}
          value={search.kind ?? ALL}
          onValueChange={(next) =>
            onSearch({ kind: next === ALL ? undefined : (next as CategorySearch['kind']) })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {kinds.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {(search.cq || search.state || search.kind) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setQ('');
            onClear();
          }}
        >
          {t('suppliers.catalog.clearFilters')}
        </Button>
      )}
    </div>
  );
}
