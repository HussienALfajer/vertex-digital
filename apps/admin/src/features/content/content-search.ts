/** `?archived=true` on the FAQ, banners and announcements: archived rows are listed too. */
export interface ArchivedSearch {
  archived?: true;
}

export function parseArchivedSearch(search: Record<string, unknown>): ArchivedSearch {
  return search.archived === true || search.archived === 'true' ? { archived: true } : {};
}
