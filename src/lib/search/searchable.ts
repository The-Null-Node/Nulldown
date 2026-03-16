export interface Searchable<T = unknown> {
  id: string;
  type: string;
  title: string;
  description?: string;
  keywords?: readonly string[];
  value: T;
}

export interface SearchableGroup<T = unknown> {
  id: string;
  label: string;
  entities: readonly Searchable<T>[];
}

const normalizeValue = (value: string) => value.trim().toLowerCase();

export const normalizeSearchQuery = normalizeValue;

export const matchesSearchable = (
  entity: Searchable,
  rawQuery: string,
): boolean => {
  const query = normalizeValue(rawQuery);
  if (!query) {
    return true;
  }

  const searchable = [
    entity.title,
    entity.description ?? "",
    entity.type,
    ...(entity.keywords ?? []),
  ]
    .join(" ")
    .toLowerCase();

  return searchable.includes(query);
};
