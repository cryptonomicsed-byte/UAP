/**
 * Multi-provider model catalog for the BYOK model picker.
 * Source: https://models.dev/api.json -- a real, public, MIT-licensed database of AI
 * providers/models (the same source OpenMausBot's own model picker uses, confirmed at
 * /opt/ares/OpenMausBot/server/model-catalog/catalog.ts). We fetch the public API directly
 * ourselves rather than vendoring their trim/cache code.
 */
import fs from 'node:fs';
import path from 'node:path';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_PATH = path.join(process.cwd(), 'data', 'model-catalog-cache.json');

export interface CatalogModel { id: string; name: string; contextWindow?: number }
export interface CatalogProvider { id: string; name: string; models: CatalogModel[] }

/** The providers UAP actually knows how to wire a key for (matches engine.ts's SHARED_ENV /
 *  Hermes config.yaml provider names) -- the full models.dev list has far more than this. */
export const SUPPORTED_PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'openrouter'] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

let memCache: { at: number; providers: CatalogProvider[] } | null = null;

function fromDisk(): { at: number; providers: CatalogProvider[] } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (raw && typeof raw.at === 'number' && Array.isArray(raw.providers)) return raw;
  } catch { /* no cache yet, or it's corrupt -- refetch */ }
  return null;
}

function toDisk(data: { at: number; providers: CatalogProvider[] }) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(data));
  } catch { /* best-effort cache; a failed write just means refetching next time */ }
}

function parseModelsDev(json: any): CatalogProvider[] {
  const providers: CatalogProvider[] = [];
  for (const [providerId, raw] of Object.entries<any>(json ?? {})) {
    if (!SUPPORTED_PROVIDERS.includes(providerId as SupportedProvider)) continue;
    const models: CatalogModel[] = Object.entries<any>(raw?.models ?? {}).map(([modelId, m]) => ({
      id: modelId,
      name: m?.name ?? modelId,
      contextWindow: typeof m?.limit?.context === 'number' ? m.limit.context : undefined,
    }));
    if (models.length) providers.push({ id: providerId, name: raw?.name ?? providerId, models: models.sort((a, b) => a.name.localeCompare(b.name)) });
  }
  return providers.sort((a, b) => a.name.localeCompare(b.name));
}

/** Always returns something usable (falls back to cache, then to a tiny hardcoded floor) --
 *  a model picker that goes blank because one HTTP fetch failed is worse than a stale list. */
export async function modelCatalog(): Promise<{ providers: CatalogProvider[]; origin: 'live' | 'cache' | 'fallback' }> {
  if (memCache && Date.now() - memCache.at < CACHE_MAX_AGE_MS) return { providers: memCache.providers, origin: 'cache' };
  const disk = fromDisk();
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`models.dev ${res.status}`);
    const providers = parseModelsDev(await res.json());
    if (!providers.length) throw new Error('empty catalog');
    memCache = { at: Date.now(), providers };
    toDisk(memCache);
    return { providers, origin: 'live' };
  } catch (error) {
    console.warn('[model-catalog] fetch failed, using', disk ? 'disk cache' : 'fallback', error instanceof Error ? error.message : error);
    if (disk) { memCache = disk; return { providers: disk.providers, origin: 'cache' }; }
    return { providers: FALLBACK_CATALOG, origin: 'fallback' };
  }
}

/** Used only if models.dev is unreachable AND there is no prior cache at all (first boot, offline). */
const FALLBACK_CATALOG: CatalogProvider[] = [
  { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }, { id: 'claude-opus-4-1', name: 'Claude Opus 4.1' }] },
  { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }, { id: 'gpt-5-mini', name: 'GPT-5 mini' }] },
  { id: 'google', name: 'Google', models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }, { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }] },
  { id: 'xai', name: 'xAI', models: [{ id: 'grok-4', name: 'Grok 4' }] },
  { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5 (via OpenRouter)' }] },
];
