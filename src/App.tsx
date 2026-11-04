import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useSearchParams } from 'react-router';
import { beijingToday, dailyGroups, filterEntries, historyEntries, indexDetails, latestEntries, listingGroups, parseCatalog, publicationViews, resolveDetail, resolveIdentity, safeSourceUrl, sortedIssues } from './reader';
import type { DetailSource } from './reader';
import type { BulletinCatalog, PublicationView, BulletinIssue } from './types';

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; catalog: BulletinCatalog };
type Favorites = { ids: string[]; error: string | null };
type DetailView = { entry: PublicationView; source: DetailSource };
type ReaderLink = { pathname: string; search: string };
const storageKey = 'nannanews-favorites-v1';

function readFavorites(): Favorites {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return { ids: [], error: null };
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error();
    return { ids: [...new Set(value)], error: null };
  } catch {
    return { ids: [], error: '无法读取本地收藏，收藏功能暂不可用。请检查浏览器存储设置。' };
  }
}

function Bookmark({ id, title, selected, disabled, compact = false, toggle }: {
  id: string; title: string; selected: boolean; disabled: boolean; compact?: boolean; toggle: (id: string) => void;
}) {
  return <label className={`bookmark${compact ? ' bookmark-compact' : ''}`}>
    <input type="checkbox" checked={selected} disabled={disabled} onChange={() => toggle(id)} aria-label={`收藏：${title}`} />
    <span>{selected ? '已收藏' : '收藏'}</span>
  </label>;
}

function SourceLinks({ urls }: { urls: string[] }) {
  const safe = [...new Set(urls.map(safeSourceUrl).filter((url): url is string => url !== null))];
  return <>{safe.map((url, index) => <a key={url} href={url} target="_blank" rel="noopener noreferrer">原文{safe.length > 1 ? ` ${index + 1}` : ''} ↗</a>)}</>;
}

function ListingTable({ entries, issueMap, sources, favorites, toggle, linkToDetail, today, showIssue, prioritizeCutoff }: {
  entries: PublicationView[]; issueMap: Map<string, BulletinIssue>; sources: Map<string, DetailSource>;
  favorites: Favorites; toggle: (id: string) => void; linkToDetail: (entry: PublicationView, source: DetailSource) => ReaderLink; today: string; showIssue: boolean; prioritizeCutoff: boolean;
}) {
  const groups = listingGroups(entries, !showIssue && !prioritizeCutoff);
  return <div className="listing-paper"><table className="listing-table">
    <caption className="sr-only">原刊清单，逐行保留。勾选活动加入本机收藏。</caption>
    <thead><tr><th scope="col" className="select-cell">收藏</th><th scope="col">消息</th><th scope="col" className="date-cell">清单截止</th><th scope="col" className="date-cell">刊载</th><th scope="col" className="links-cell">阅读</th></tr></thead>
    {groups.map(({ category, rows }, groupIndex) => <tbody key={`${category}-${groupIndex}`}>
      <tr className="category-row"><th colSpan={5} scope="rowgroup">{category || '未分类'}</th></tr>
      {rows.map(({ entry, row }) => {
        const source = sources.get(entry.id);
        return <tr key={row.id}>
          <td className="select-cell"><Bookmark id={entry.id} title={row.title} selected={favorites.ids.includes(entry.id)} disabled={!!favorites.error} compact toggle={toggle} /></td>
          <td className="title-cell">{source ? <NavLink to={linkToDetail(entry, source)}>{row.title}</NavLink> : <span>{row.title}</span>}</td>
          <td className={`date-cell cutoff-cell${row.cutoff && row.cutoff < today ? ' past-cutoff' : ''}`} data-label="清单截止"><time dateTime={row.cutoff ?? undefined}>{row.cutoff_raw || '未明确'}</time></td>
          <td className="date-cell listed-cell" data-label="刊载"><time dateTime={row.listed_on ?? undefined}>{row.listed_raw || '未明确'}</time></td>
          <td className="links-cell"><div className="row-links">
            {source ? <NavLink to={linkToDetail(entry, source)}>{source.issue.id === entry.issue_id ? '本期详解' : `${source.issue.date.slice(5)} 详解`}</NavLink> : <span className="muted">本地未收录详解</span>}
            <SourceLinks urls={row.source_urls} />
            {showIssue && <span className="row-issue">清单来自 {issueMap.get(entry.issue_id)?.date}</span>}
          </div></td>
        </tr>;
      })}
    </tbody>)}
  </table></div>;
}

function DetailArticle({ view, favorites, toggle, returnToList }: { view: DetailView; favorites: Favorites; toggle: (id: string) => void; returnToList: () => void }) {
  const { entry, source } = view;
  const otherUrls = [...new Set(source.detail.other_urls.map(safeSourceUrl).filter((url): url is string => url !== null))];
  return <article className="detail-article" id={`detail-${entry.id}`} tabIndex={-1}>
    <div className="detail-heading"><h4>{source.detail.title}</h4><Bookmark id={entry.id} title={source.detail.title} selected={favorites.ids.includes(entry.id)} disabled={!!favorites.error} toggle={toggle} /></div>
    <p className="original-text">{source.detail.text}</p>
    <div className="source-links"><SourceLinks urls={source.detail.source_urls} />{otherUrls.map((url, index) => <a key={url} href={url} target="_blank" rel="noopener noreferrer">其他原刊链接{otherUrls.length > 1 ? ` ${index + 1}` : ''} ↗</a>)}</div>
    <div className="source-note"><span>详解刊于 {source.issue.date} · 第 {source.issue.number} 期 · PDF 第 {source.detail.page} 页</span><button className="back-to-list" type="button" onClick={returnToList}>回到清单 ↑</button></div>
  </article>;
}

export default function App() {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [favorites, setFavorites] = useState<Favorites>(readFavorites);
  const [today, setToday] = useState(() => beijingToday());
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const mode = location.pathname === '/history' ? 'history' : location.pathname === '/favorites' ? 'favorites' : 'daily';
  const query = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const openOnly = mode === 'daily' && params.get('open') === '1';
  const focusId = params.get('detail');

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: 'loading' });
    fetch(`${import.meta.env.BASE_URL}data/catalog.json`, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error(`无法读取数据（HTTP ${response.status}）`);
        return response.json() as Promise<unknown>;
      })
      .then(data => setLoad({ status: 'ready', catalog: parseCatalog(data) }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ status: 'error', message: error instanceof Error ? error.message : '无法读取数据' });
      });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    let timer: number;
    function refreshDay() {
      clearTimeout(timer);
      setToday(beijingToday());
      const now = Date.now();
      const beijingOffset = 8 * 60 * 60 * 1000;
      const day = 24 * 60 * 60 * 1000;
      timer = window.setTimeout(refreshDay, day - ((now + beijingOffset) % day) + 100);
    }
    refreshDay();
    window.addEventListener('focus', refreshDay);
    document.addEventListener('visibilitychange', refreshDay);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', refreshDay);
      document.removeEventListener('visibilitychange', refreshDay);
    };
  }, []);

  const catalog = load.status === 'ready' ? load.catalog : null;
  const issues = useMemo(() => catalog ? sortedIssues(catalog.issues) : [], [catalog]);
  const issueMap = useMemo(() => new Map(issues.map(issue => [issue.id, issue])), [issues]);
  const explanations = useMemo(() => catalog ? indexDetails(catalog) : new Map<string, DetailSource[]>(), [catalog]);
  const newest = issues[0];
  const issueParam = params.get('issue');
  const selectedIssue = issueParam === 'all' || issues.some(issue => issue.id === issueParam) ? issueParam : newest?.id;
  const readingIssue = mode === 'daily' ? newest : mode === 'history' && selectedIssue !== 'all' ? issueMap.get(selectedIssue ?? '') : undefined;
  const entries = useMemo(() => catalog ? publicationViews(catalog) : [], [catalog]);
  const favoriteIds = new Set(catalog ? favorites.ids.map(id => resolveIdentity(catalog, id)).filter((id): id is string => id !== null) : []);
  const displayFavorites = { ...favorites, ids: [...favoriteIds] };
  const favoriteCount = favoriteIds.size + favorites.ids.filter(id => !catalog || !resolveIdentity(catalog, id)).length;
  const groups = newest && openOnly ? dailyGroups(entries, newest.id, today) : null;
  const available = !catalog ? [] : mode === 'history' ? (selectedIssue === 'all' ? entries : historyEntries(catalog, selectedIssue ?? ''))
    : mode === 'favorites' ? latestEntries(catalog, entries).filter(entry => favoriteIds.has(entry.id))
      : groups ? [...groups.current, ...groups.unknown, ...groups.notices] : entries.filter(entry => entry.issue_id === newest?.id);
  const categories = [...new Set(available.flatMap(entry => [entry.category, ...entry.listings.map(row => row.category), entry.detail?.category ?? '']).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const searchSources = new Map<string, DetailSource>();
  if (mode === 'favorites') for (const entry of available) {
    const source = resolveDetail(entry, issueMap.get(entry.issue_id), explanations);
    if (source) searchSources.set(`${entry.issue_id}\0${entry.id}`, source);
  }
  const filtered = catalog && mode === 'history' ? historyEntries(catalog, selectedIssue ?? '', query, category) : filterEntries(available, query, category, searchSources);
  const resolved = new Map<string, DetailSource>();
  const detailViews: DetailView[] = [];
  for (const entry of filtered) {
    const source = resolveDetail(entry, issueMap.get(entry.issue_id), explanations);
    if (source) resolved.set(entry.id, source);
    if (!source || (readingIssue && !entry.detail)) continue;
    detailViews.push({ entry, source });
  }
  if (readingIssue) detailViews.sort((a, b) => a.source.detail.order - b.source.detail.order);
  const detailGroups: { category: string; views: DetailView[] }[] = [];
  for (const view of detailViews) {
    const name = view.source.detail.category;
    if (!detailGroups.length || detailGroups[detailGroups.length - 1].category !== name) detailGroups.push({ category: name, views: [] });
    detailGroups[detailGroups.length - 1].views.push(view);
  }
  const rowCount = filtered.reduce((count, entry) => count + entry.listings.length, 0);
  const detailTitle = readingIssue ? '本期新增详解' : '原刊详解';
  const resolvedFocusId = catalog && focusId ? resolveIdentity(catalog, focusId) ?? focusId : focusId;

  useEffect(() => {
    if (load.status !== 'ready' || !resolvedFocusId) return;
    const target = document.getElementById(`detail-${resolvedFocusId}`);
    target?.scrollIntoView({ block: 'start' });
    target?.focus({ preventScroll: true });
  }, [load, resolvedFocusId, mode, selectedIssue, location.key]);

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    next.delete('detail');
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: key === 'q' });
  }
  function clearFilters() {
    const next = new URLSearchParams();
    if (mode === 'history' && selectedIssue) next.set('issue', selectedIssue);
    setParams(next);
  }
  function returnToList() {
    const next = new URLSearchParams(params);
    next.delete('detail');
    setParams(next, { replace: true });
    const heading = document.getElementById('listing-heading');
    heading?.scrollIntoView({ block: 'start' });
    heading?.focus({ preventScroll: true });
  }
  function linkToDetail(entry: PublicationView, source: DetailSource): ReaderLink {
    const inCurrentView = readingIssue?.id === source.issue.id;
    const next = inCurrentView ? new URLSearchParams(params) : new URLSearchParams({ issue: source.issue.id });
    next.set('detail', entry.id);
    return { pathname: inCurrentView ? location.pathname : '/history', search: `?${next}` };
  }
  function toggleFavorite(id: string) {
    if (favorites.error) return;
    const ids = favoriteIds.has(id) ? favorites.ids.filter(item => !catalog || resolveIdentity(catalog, item) !== id) : [...favorites.ids, id];
    try {
      localStorage.setItem(storageKey, JSON.stringify(ids));
      setFavorites({ ids, error: null });
    } catch {
      setFavorites({ ids: favorites.ids, error: '无法保存本地收藏，本次更改未保存。请检查浏览器存储设置。' });
    }
  }

  return <div className="app">
    <header className="header"><div className="header-inner"><NavLink className="brand" to="/"><span className="brand-mark" aria-hidden="true">南</span><span>NannaNews <small>消息阅读</small></span></NavLink><span className="header-note">读原刊，选你关心的活动</span></div>
      <nav className="navigation" aria-label="主要导航"><div className="nav-inner"><NavLink end to="/">本期日报</NavLink><NavLink to="/history">往期日报</NavLink><NavLink to="/favorites">我的收藏<span className="nav-count">{favoriteCount || ''}</span></NavLink></div></nav>
    </header>
    <main className="main">
      <div className="page-heading"><div><p className="eyebrow">{mode === 'daily' ? '最新一期原刊' : mode === 'history' ? '按刊期阅读' : '只保存在本机'}</p><h1>{mode === 'favorites' ? '我的收藏' : readingIssue ? readingIssue.title : '往期日报'}</h1></div>
        {readingIssue && <div className="issue-stamp"><strong>{readingIssue.date}</strong><span>第 {readingIssue.number} 期</span></div>}
      </div>
      {favorites.error && <p className="notice" role="alert">{favorites.error}</p>}
      {load.status === 'loading' && <p role="status" className="empty">正在加载消息数据…</p>}
      {load.status === 'error' && <div className="empty" role="alert"><p>消息数据加载失败：{load.message}</p><p>数据可能尚未发布，或暂时无法访问。</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></div>}
      {catalog && (issues.length === 0 ? <p className="empty">暂无期刊数据。</p> : <>
        <div className="filters">
          {mode === 'history' && <label>期刊<select value={selectedIssue ?? ''} onChange={event => updateParam('issue', event.target.value)}><option value="all">全部期刊（跨期去重）</option>{issues.map(issue => <option key={issue.id} value={issue.id}>{issue.date} · 第 {issue.number} 期</option>)}</select></label>}
          <label className="search">关键词<input type="search" value={query} onChange={event => updateParam('q', event.target.value)} placeholder="搜索原刊标题和正文" /></label>
          <label>栏目<select value={category} onChange={event => updateParam('category', event.target.value)}><option value="">全部栏目</option>{category && !categories.includes(category) && <option value={category}>{category}</option>}{categories.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
          {mode === 'daily' && <button className="filter-toggle" type="button" aria-pressed={openOnly} onClick={() => updateParam('open', openOnly ? '' : '1')}>只看未过清单截止</button>}
          {(query || category || openOnly) && <button className="clear-filter" type="button" onClick={clearFilters}>清除筛选</button>}
        </div>
        <p className="context">{mode === 'favorites' ? '勾选即收藏，同一活动在清单和详解中同步。收藏仅保存在当前浏览器。' : openOnly ? `按北京时间 ${today} 筛选；日期未明确的条目仍保留。清单截止不代表报名仍开放。` : '按原刊保留清单与说明；点击消息可阅读对应详解，往期详解会注明刊期。'}</p>
        {focusId && !detailViews.some(view => view.entry.id === resolvedFocusId) && <p className="notice" role="status">当前数据或筛选范围暂时无法对应这条详解。可以清除筛选，或选择原刊期查看。</p>}
        {filtered.length === 0 ? <div className="empty"><p>{query || category || openOnly ? '没有符合筛选条件的消息。' : mode === 'favorites' ? (favorites.ids.length ? '已保存的收藏暂时无法对应当前活动，收藏记录仍然保留。' : '还没有收藏的活动。勾选清单或详解旁的方框即可收藏。') : '本期暂无可展示的消息。'}</p>{(query || category || openOnly) && <button type="button" onClick={clearFilters}>显示原刊全部消息</button>}</div> : <div className="reading-sections">
          <section aria-labelledby="listing-heading"><div className="section-heading"><div><span className="section-number">01</span><h2 id="listing-heading" tabIndex={-1}>{mode === 'favorites' ? '已收藏清单' : '原刊清单'}</h2><span className="section-count">{rowCount} 行</span></div><span className="section-hint">勾选收藏 · 点击标题阅读</span></div>
            {rowCount ? (
              <ListingTable entries={filtered} issueMap={issueMap} sources={resolved} favorites={displayFavorites} toggle={toggleFavorite} linkToDetail={linkToDetail} today={today} showIssue={!readingIssue} prioritizeCutoff={openOnly} />
            ) : (
              <p className="section-empty">这些消息只有原刊说明，没有清单行，见下方详解。</p>
            )}
          </section>
          <section aria-labelledby="detail-heading"><div className="section-heading"><div><span className="section-number">02</span><h2 id="detail-heading">{detailTitle}</h2><span className="section-count">{detailViews.length} 条</span></div><span className="section-hint">{readingIssue ? '只列本期实际刊印的说明' : '每条保留原刊日期与页码'}</span></div>
            {detailViews.length ? detailGroups.map(({ category: group, views }, index) => <section className="detail-category" key={`${group}-${index}`}><h3>{group || '未分类'}</h3><div className="detail-grid">{views.map(view => <DetailArticle key={`${view.source.issue.id}-${view.entry.id}`} view={view} favorites={displayFavorites} toggle={toggleFavorite} returnToList={returnToList} />)}</div></section>) : <p className="section-empty">当前范围没有已收录的详解。清单中的日期链接可打开已收录的往期说明。</p>}
          </section>
        </div>}
        {mode === 'favorites' && available.length > 0 && favorites.ids.some(id => !resolveIdentity(catalog, id)) && <p className="context">部分历史收藏暂时无法对应当前活动，原记录已保留。</p>}
        <p className="page-footnote">内容依据原刊，不补写或校对原文。活动安排与参与方式请以原始通知为准。</p>
      </>)}
    </main>
  </div>;
}
