import MiniSearch from 'minisearch';
import { searchOptions, tokenize } from './tokenize.mjs';
import type { StaticDataset } from './data';
import { historyText } from './transport';

// A failed load is discarded so a subsequent explicit retry can recover.
const indexes = new WeakMap<StaticDataset, Promise<MiniSearch>>();

function loadIndex(dataset: StaticDataset): Promise<MiniSearch> {
  let pending = indexes.get(dataset);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(`${dataset.searchIndexUrl}.gz`, { credentials: 'omit' });
      if (!response.ok) throw new Error(`历史搜索索引加载失败（${response.status}）。`);
      const serialized = await historyText(response);
      return MiniSearch.loadJSONAsync(serialized, searchOptions);
    })();
    indexes.set(dataset, pending);
    pending.catch(() => { if (indexes.get(dataset) === pending) indexes.delete(dataset); });
  }
  return pending;
}

export async function searchHistory(dataset: StaticDataset, query: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  if (tokenize(query).length === 0) return [];
  const pending = loadIndex(dataset);
  let index: MiniSearch;
  if (signal) {
    const result = Promise.withResolvers<MiniSearch>();
    const abort = () => result.reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    pending.then(result.resolve, result.reject).finally(() => signal.removeEventListener('abort', abort));
    index = await result.promise;
  } else index = await pending;
  signal?.throwIfAborted();
  const ids = index.search(query).map(result => String(result.id));
  signal?.throwIfAborted();
  return ids;
}
