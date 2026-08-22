export interface RegistryCallDescription {
  message: string;
  details: { tool: string; arguments: Record<string, unknown> };
}

export function describeRegistryCall(item: Record<string, unknown>): RegistryCallDescription {
  const nested = asRecord(item.toolCall) ?? asRecord(item.call) ?? {};
  const rawTool = firstString(item.tool, item.toolName, item.name, nested.tool, nested.name) || 'registry.unknown';
  const namespace = firstString(item.namespace, nested.namespace);
  const shortTool = normalizeToolName(rawTool);
  const tool = shortTool === 'unknown'
    ? (namespace ? `${namespace}.${shortTool}` : rawTool)
    : `registry.${shortTool}`;
  const args = filterArguments(shortTool, readArguments(item, nested));
  return { message: describe(shortTool, args), details: { tool, arguments: args } };
}

function describe(tool: string, args: Record<string, unknown>): string {
  if (tool === 'list_tags') return 'Codex pobiera listę dostępnych kategorii i tagów z registry.';
  if (tool === 'list_references') return 'Codex sprawdza opisy obrazów referencyjnych projektu.';
  if (tool === 'get_reference') {
    return `Codex pobiera projektowy obraz referencyjny: ${compactText(args.referenceId) || 'nieznana referencja'}.`;
  }
  if (tool === 'propose_project_settings') {
    return 'Codex proponuje zmianę ustawień projektu do zatwierdzenia.';
  }
  if (tool === 'get_asset') {
    const asset = compactText(args.assetId) || 'nieznany asset';
    const version = compactText(args.versionId);
    return `Codex pobiera obraz referencyjny z registry: ${asset}${version ? `, wersja ${version}` : ', wersja zatwierdzona'}.`;
  }
  if (tool === 'search_assets') {
    const criteria: string[] = [];
    const query = compactText(args.query);
    const category = compactText(args.category);
    const tags = stringList(args.tags);
    const statuses = stringList(args.statuses);
    if (query) criteria.push(`fraza „${query}”`);
    if (category) criteria.push(`kategoria ${category}`);
    if (tags.length) criteria.push(`tagi: ${tags.join(', ')}`);
    if (statuses.length) criteria.push(`statusy: ${statuses.join(', ')}`);
    if (typeof args.limit === 'number') criteria.push(`limit ${args.limit}`);
    return criteria.length
      ? `Codex szuka assetów w registry — ${criteria.join(' · ')}.`
      : 'Codex przegląda zatwierdzone assety w registry bez dodatkowych filtrów.';
  }
  return `Codex używa narzędzia registry: ${tool}.`;
}

function readArguments(item: Record<string, unknown>, nested: Record<string, unknown>): Record<string, unknown> {
  const candidate = item.arguments ?? item.input ?? nested.arguments ?? nested.input ?? {};
  if (typeof candidate === 'string') {
    try { return asRecord(JSON.parse(candidate)) ?? { value: candidate.slice(0, 2_000) }; } catch { return { value: candidate.slice(0, 2_000) }; }
  }
  return asRecord(candidate) ?? {};
}

function filterArguments(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const allowed = tool === 'search_assets'
    ? ['query', 'category', 'tags', 'statuses', 'limit']
    : tool === 'get_asset'
      ? ['assetId', 'versionId']
      : tool === 'get_reference'
        ? ['referenceId']
      : tool === 'propose_project_settings'
        ? ['reason', 'settings', 'referenceIds']
      : tool === 'list_tags'
        ? []
        : tool === 'list_references'
          ? []
        : Object.keys(args).slice(0, 20);
  return Object.fromEntries(allowed.filter((key) => args[key] !== undefined).map((key) => [key, sanitize(args[key])]));
}

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, 2_000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(sanitize);
  const record = asRecord(value);
  if (record) return Object.fromEntries(Object.entries(record).slice(0, 50).map(([key, item]) => [key, sanitize(item)]));
  return String(value).slice(0, 2_000);
}

function normalizeToolName(value: string): string {
  const normalized = value.toLocaleLowerCase().replace(/^registry[./:]/, '');
  if (normalized.includes('search_assets') || normalized.endsWith('searchassets')) return 'search_assets';
  if (normalized.includes('list_tags') || normalized.endsWith('listtags')) return 'list_tags';
  if (normalized.includes('get_asset') || normalized.endsWith('getasset')) return 'get_asset';
  if (normalized.includes('list_references') || normalized.endsWith('listreferences')) return 'list_references';
  if (normalized.includes('get_reference') || normalized.endsWith('getreference')) return 'get_reference';
  if (normalized.includes('propose_project_settings') || normalized.endsWith('proposeprojectsettings')) return 'propose_project_settings';
  return normalized.split(/[./:]/).at(-1) || 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0) ?? '';
}

function compactText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 20) : [];
}
