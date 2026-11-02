import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useSearchParams } from 'react-router';
import { beijingToday, dailyGroups, entryCutoff, entrySourceUrls, entryTitle, filterEntries, historyEntries, latestEntries, parseCatalog, safeSourceUrl, sortedIssues } from './reader';
import type { BulletinCatalog, BulletinEntry, BulletinIssue } from './types';

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; catalog: BulletinCatalog };
type Favorites = { ids: string[]; error: string | null };
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

function EntryCard({ entry, issue, favorite, toggle }: {
  entry: BulletinEntry; issue: BulletinIssue | undefined; favorite: boolean; toggle: (id: string) => void;
}) {
  const title = entryTitle(entry);
  const cutoff = entryCutoff(entry);
  const urls = [...new Set(entrySourceUrls(entry).map(safeSourceUrl).filter((url): url is string => url !== null))];
  const otherUrls = [...new Set((entry.detail?.other_urls ?? []).map(safeSourceUrl).filter((url): url is string => url !== null))];
  const facts = (entry.detail?.fields ?? []).filter(field => /(?:时间|地点)$/.test(field.label) && !/(?:截止|报名|申请|投递|报送|提交)/.test(field.label)).slice(0, 2);
  const sourcePage = entry.detail?.page ?? entry.listings[0]?.page;
  return <article className="entry">
    <div className="entry-heading">
      <div><span className="category">{entry.category || '未分类'}</span><h3>{title}</h3></div>
      <button className="favorite" type="button" aria-pressed={favorite} aria-label={`${favorite ? '取消收藏' : '收藏'}：${title}`} onClick={() => toggle(entry.id)}>{favorite ? '★' : '☆'}<span>{favorite ? '已收藏' : '收藏'}</span></button>
    </div>
    {(entry.listings.length > 0 || facts.length > 0) && <p className="facts">{entry.listings.length > 0 && <strong>清单截止：{cutoff ?? (entry.listings.map(row => row.cutoff_raw).filter(Boolean).join('／') || '未明确')}</strong>}{facts.map((field, index) => <span key={`${field.label}-${index}`}>{field.label}：{field.value}</span>)}</p>}
    <div className="entry-actions">{urls.length ? urls.map(url => <a key={url} href={url} target="_blank" rel="noopener noreferrer">查看原文 ↗</a>) : <span>原文链接未提供</span>}</div>
    <details><summary>查看原刊内容与来源</summary><div className="details-body">
      {entry.detail && <><h4>{entry.detail.title}</h4><p className="excerpt">{entry.detail.text}</p></>}
      {entry.listings.map((row, index) => <p key={index}>原刊清单：{row.title} · 截止 {row.cutoff_raw || '未明确'} · 刊载 {row.listed_raw || '未明确'}</p>)}
      {otherUrls.length > 0 && <p>{otherUrls.map(url => <a key={url} href={url} target="_blank" rel="noopener noreferrer">原刊其他链接 ↗ </a>)}</p>}
      <p>来源：{issue ? `${issue.date} · 第 ${issue.number} 期 · ${issue.title}` : '期刊信息未提供'} · PDF 第 {sourcePage} 页</p>
    </div></details>
  </article>;
}

function EntryList({ entries, issueMap, favorites, toggle }: {
  entries: BulletinEntry[]; issueMap: Map<string, BulletinIssue>; favorites: string[]; toggle: (id: string) => void;
}) {
  return <div className="entry-list">{entries.map((entry, index) => <EntryCard key={`${entry.issue_id}-${entry.id}-${index}`} entry={entry} issue={issueMap.get(entry.issue_id)} favorite={favorites.includes(entry.id)} toggle={toggle} />)}</div>;
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
  const newest = issues[0];
  const issueParam = params.get('issue');
  const selectedIssue = issueParam === 'all' || issues.some(issue => issue.id === issueParam) ? issueParam : newest?.id;
  const groups = catalog && newest ? dailyGroups(catalog.entries, newest.id, today) : { current: [], unknown: [], notices: [] };
  const available = !catalog ? [] : mode === 'history' ? (selectedIssue === 'all' ? catalog.entries : historyEntries(catalog, selectedIssue ?? '')) : mode === 'favorites' ? latestEntries(catalog).filter(entry => favorites.ids.includes(entry.id)) : [...groups.current, ...groups.unknown, ...groups.notices];
  const categories = [...new Set(available.map(entry => entry.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const filtered = catalog && mode === 'history' ? historyEntries(catalog, selectedIssue ?? '', query, category) : filterEntries(available, query, category);
  const filteredGroups = {
    current: filterEntries(groups.current, query, category),
    unknown: filterEntries(groups.unknown, query, category),
    notices: filterEntries(groups.notices, query, category),
  };

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: key === 'q' });
  }
  function toggleFavorite(id: string) {
    if (favorites.error) return;
    const ids = favorites.ids.includes(id) ? favorites.ids.filter(item => item !== id) : [...favorites.ids, id];
    try {
      localStorage.setItem(storageKey, JSON.stringify(ids));
      setFavorites({ ids, error: null });
    } catch {
      setFavorites({ ids: favorites.ids, error: '无法保存本地收藏，本次更改未保存。请检查浏览器存储设置。' });
    }
  }

  return <div className="app">
    <header className="header"><div className="header-inner"><NavLink className="brand" to="/"> <span className="brand-mark" aria-hidden="true">南</span><span>NannaNews <small>消息阅读</small></span></NavLink></div>
      <nav className="navigation" aria-label="主要导航"><div className="nav-inner">
        <NavLink end to={{ pathname: '/', search: location.search }}>每日清单</NavLink>
        <NavLink to={{ pathname: '/history', search: location.search }}>往期消息</NavLink>
        <NavLink to={{ pathname: '/favorites', search: location.search }}>我的收藏</NavLink>
      </div></nav>
    </header>
    <main className="main">
      <div className="page-heading"><h1>{mode === 'daily' ? '每日清单' : mode === 'history' ? '往期消息' : '我的收藏'}</h1>
        {newest && mode === 'daily' && <p>最新 PDF：{newest.date} · 第 {newest.number} 期</p>}
        {mode === 'history' && <p>按期浏览，或选择全部期刊跨期搜索。</p>}
        {mode === 'favorites' && <p>收藏保存在此浏览器中。</p>}
      </div>
      {favorites.error && <p className="notice" role="alert">{favorites.error}</p>}
      {load.status === 'loading' && <p role="status" className="empty">正在加载消息数据…</p>}
      {load.status === 'error' && <div className="empty" role="alert"><p>消息数据加载失败：{load.message}</p><p>数据可能尚未发布，或暂时无法访问。</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></div>}
      {catalog && (issues.length === 0 ? <p className="empty">暂无期刊数据。</p> : <>
        <div className="filters">
          {mode === 'history' && <label>期刊<select value={selectedIssue ?? ''} onChange={event => updateParam('issue', event.target.value)}><option value="all">全部期刊（跨期去重）</option>{issues.map(issue => <option key={issue.id} value={issue.id}>{issue.date} · 第 {issue.number} 期</option>)}</select></label>}
          <label className="search">关键词<input type="search" value={query} onChange={event => updateParam('q', event.target.value)} placeholder={mode === 'history' && selectedIssue === 'all' ? '搜索全部期刊' : '搜索消息'} /></label>
          <label>分类<select value={category} onChange={event => updateParam('category', event.target.value)}><option value="">全部分类</option>{category && !categories.includes(category) && <option value={category}>{category}</option>}{categories.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
        </div>
        {mode === 'daily' && <p className="context">按最新一期 PDF 的清单截止日期筛选（北京时间）；清单截止不代表报名仍开放。</p>}
        {mode === 'history' && selectedIssue !== 'all' && selectedIssue && <p className="context">来源 PDF：{issueMap.get(selectedIssue)?.date} · 第 {issueMap.get(selectedIssue)?.number} 期；包含已过清单截止日期的消息。</p>}
        {filtered.length === 0 ? <p className="empty">{query || category ? '没有符合筛选条件的消息。' : mode === 'favorites' ? '还没有收藏的消息。' : '这里暂时没有消息。'}</p> : mode === 'daily' ? <div className="groups">
          {filteredGroups.current.length > 0 && <section><h2>清单消息 <span>{filteredGroups.current.length}</span></h2><EntryList entries={filteredGroups.current} issueMap={issueMap} favorites={favorites.ids} toggle={toggleFavorite} /></section>}
          {filteredGroups.unknown.length > 0 && <section><h2>待明确日期 <span>{filteredGroups.unknown.length}</span></h2><EntryList entries={filteredGroups.unknown} issueMap={issueMap} favorites={favorites.ids} toggle={toggleFavorite} /></section>}
          {filteredGroups.notices.length > 0 && <section><h2>新通知 <span>{filteredGroups.notices.length}</span></h2><EntryList entries={filteredGroups.notices} issueMap={issueMap} favorites={favorites.ids} toggle={toggleFavorite} /></section>}
        </div> : <EntryList entries={filtered} issueMap={issueMap} favorites={favorites.ids} toggle={toggleFavorite} />}
        {mode === 'favorites' && favorites.ids.some(id => !latestEntries(catalog).some(entry => entry.id === id)) && <p className="context">部分收藏未出现在当前数据中。</p>}
      </>)}
    </main>
  </div>;
}
