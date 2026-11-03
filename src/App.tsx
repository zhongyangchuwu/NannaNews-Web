import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router';
import { beijingToday, entryCutoff, filterEntries, indexDetails, listingGroups, parseCatalog, resolveDetail, resolveIdentity, safeSourceUrl } from './reader';
import type { DetailSource as DatedDetail } from './reader';
import { aggregateActivities, activityCutoff, searchActivities } from './activities';
import type { ActivityMatch, ActivityView } from './activities';
import { buildDiaryIndex, diaryDay, diaryWindow, formatSourceDate, isCalendarDate, openDiaryPublications, recentRecordedDay, shiftDay } from './diary';
import type { DiaryDay, PrintedMessage } from './diary';
import { activityLink, diaryLink, legacyLocation, returnKey, returnTarget, sourceLink } from './navigation';
import type { DiarySection, ReaderLink } from './navigation';
import type { BulletinCatalog, BulletinIssue, ListingSource, PublicationView } from './types';

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

function Bookmark({ id, title, favorites, toggle, compact = false }: {
  id: string; title: string; favorites: Favorites; toggle: (id: string) => void; compact?: boolean;
}) {
  const selected = favorites.ids.includes(id);
  return <button className={`bookmark${compact ? ' bookmark-compact' : ''}`} type="button" aria-pressed={selected}
    aria-label={`${selected ? '取消收藏' : '收藏'}：${title}`} disabled={!!favorites.error} onClick={() => toggle(id)}>
    {selected ? '已收藏' : '收藏'}
  </button>;
}

function SourceLinks({ urls, label = '原文' }: { urls: string[]; label?: string }) {
  const safe = [...new Set(urls.map(safeSourceUrl).filter((url): url is string => url !== null))];
  return <>{safe.map((url, index) => <a key={url} href={url} target="_blank" rel="noopener noreferrer">{label}{safe.length > 1 ? ` ${index + 1}` : ''} ↗</a>)}</>;
}

function returnLabel(target: ReaderLink): string {
  const params = new URLSearchParams(target.search);
  if (target.pathname === '/activities') return params.has('activity') ? '返回活动详情' : '返回所有活动';
  if (target.pathname === '/favorites') return params.has('activity') ? '返回收藏活动' : '返回我的收藏';
  return params.get('view') === 'list' ? '返回原刊清单' : '返回当天新增';
}

function PrintedArticle({ message, favorites, toggle, back, archive, showFavorite = true }: {
  message: PrintedMessage; favorites: Favorites; toggle: (id: string) => void; back: ReaderLink; archive?: ReaderLink; showFavorite?: boolean;
}) {
  const { activityId, issue, detail } = message;
  return <article className="detail-article" id={`detail-${detail.id}`} tabIndex={-1}>
    <div className="detail-heading"><h4>{detail.title}</h4>{showFavorite && <Bookmark id={activityId} title={detail.title} favorites={favorites} toggle={toggle} />}</div>
    <p className="original-text">{detail.text}</p>
    <div className="source-links"><SourceLinks urls={detail.source_urls} /><SourceLinks urls={detail.other_urls} label="其他原刊链接" />{archive && <Link to={archive}>活动与刊载记录</Link>}</div>
    <div className="source-note"><span>详解刊于 {issue.date} · 第 {issue.number} 期 · PDF 第 {detail.page} 页</span><Link to={back}>{returnLabel(back)} ↑</Link></div>
  </article>;
}

function DateNavigation({ index, day, today, followToday, view, query, category, openOnly, select }: {
  index: ReadonlyMap<string, DiaryDay>; day: DiaryDay; today: string; followToday: boolean; view: DiarySection;
  query: string; category: string; openOnly: boolean; select: (date: string) => void;
}) {
  const context = { q: query, category, open: openOnly };
  const epoch = Date.parse(`${day.date}T00:00:00Z`);
  const radius = Math.min(3, Math.floor((epoch - Date.parse('0000-01-01T00:00:00Z')) / 86400000), Math.floor((Date.parse('9999-12-31T00:00:00Z') - epoch) / 86400000));
  const days = diaryWindow(index, day.date, radius);
  const previous = day.date > '0000-01-01' ? shiftDay(day.date, -1) : null;
  const next = day.date < '9999-12-31' ? shiftDay(day.date, 1) : null;
  const description = (item: DiaryDay) => item.state === 'new' ? `${item.details.length} 条新增说明` : item.state === 'no-new' ? '已收录，无新增说明' : '暂无已收录日报';
  return <section className="date-navigation" aria-label="日报日期选择">
    <div className="date-controls">
      {previous ? <Link className="date-arrow" to={diaryLink(previous, view, context)} aria-label="前一天">←</Link> : <span className="date-arrow disabled">←</span>}
      <label className="date-picker">查看日期<input type="date" value={day.date} onChange={event => { if (isCalendarDate(event.target.value)) select(event.target.value); }} /></label>
      {next ? <Link className="date-arrow" to={diaryLink(next, view, context)} aria-label="后一天">→</Link> : <span className="date-arrow disabled">→</span>}
      <Link className={`today-link${followToday ? ' following' : ''}`} to={diaryLink(null, view, context)}>{followToday ? '正在跟随今天' : '回到今天'}</Link>
    </div>
    <p className="date-window-range">{days[0].date} — {days[days.length - 1].date} · 北京时间</p>
    <nav className="date-window" aria-label="附近日期的收录情况">{days.map(item => <Link key={item.date} to={diaryLink(item.date, view, context)} data-state={item.state} aria-current={item.date === day.date ? 'date' : undefined} aria-label={`${item.date}，${description(item)}`}>
      <time dateTime={item.date}>{item.date.slice(5)}</time><span>{item.state === 'new' ? `${item.details.length} 条新增` : item.state === 'no-new' ? '无新增说明' : '未收录'}</span>
    </Link>)}</nav>
    <p className="date-legend">有新增 · 已收录但无新增说明 · 未收录（不代表当天没有消息）</p>
  </section>;
}

function Filters({ query, category, categories, openOnly, onChange, clear, showCutoff, activityMode = false }: {
  query: string; category: string; categories: string[]; openOnly: boolean;
  onChange: (key: string, value: string) => void; clear: () => void; showCutoff: boolean; activityMode?: boolean;
}) {
  return <div className="filters">
    <label className="search">关键词<input type="search" value={query} onChange={event => onChange('q', event.target.value)} placeholder={activityMode ? '搜索所有刊载标题与正文' : '搜索当天原刊标题与正文'} /></label>
    <label>{activityMode ? '曾刊栏目' : '栏目'}<select value={category} onChange={event => onChange('category', event.target.value)}><option value="">全部栏目</option>{category && !categories.includes(category) && <option value={category}>{category}</option>}{categories.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
    {showCutoff && <button className="filter-toggle" type="button" aria-pressed={openOnly} onClick={() => onChange('open', openOnly ? '' : '1')}>只看未过清单截止</button>}
    {(query || category || openOnly) && <button className="clear-filter" type="button" onClick={clear}>清除筛选</button>}
  </div>;
}

function ListingTable({ entries, issueMap, detailIndex, favorites, toggle, today, category, sourceOrder, showIssue, openSource, archive }: {
  entries: PublicationView[]; issueMap: ReadonlyMap<string, BulletinIssue>; detailIndex: ReadonlyMap<string, readonly DatedDetail[]>;
  favorites: Favorites; toggle: (id: string) => void; today: string; category: string; sourceOrder: boolean; showIssue: boolean;
  openSource: (entry: PublicationView, row: ListingSource, source: DatedDetail) => ReaderLink; archive: (entry: PublicationView, row: ListingSource) => ReaderLink;
}) {
  const scoped = category ? entries.map(entry => ({ ...entry, listings: entry.listings.filter(row => row.category === category) })) : entries;
  const groups = listingGroups(scoped, sourceOrder);
  return <div className="listing-paper"><table className="listing-table">
    <caption className="sr-only">原刊清单，逐行保留；收藏按钮保存在本机。</caption>
    <thead><tr><th scope="col" className="select-cell">收藏</th><th scope="col">消息</th><th scope="col" className="date-cell">清单截止</th><th scope="col" className="date-cell">刊载</th><th scope="col" className="links-cell">阅读</th></tr></thead>
    {groups.map((group, groupIndex) => <tbody key={`${group.category}-${groupIndex}`}>
      <tr className="category-row"><th colSpan={5} scope="rowgroup">{group.category || '未分类'}</th></tr>
      {group.rows.map(({ entry, row }) => {
        const source = resolveDetail(entry, issueMap.get(entry.issue_id), detailIndex);
        return <tr key={row.id} id={`row-${row.id}`} tabIndex={-1}>
          <td className="select-cell"><Bookmark id={entry.id} title={row.title} favorites={favorites} compact toggle={toggle} /></td>
          <td className="title-cell"><Link to={source ? openSource(entry, row, source) : archive(entry, row)}>{row.title}</Link></td>
          <td className={`date-cell cutoff-cell${row.cutoff && row.cutoff < today ? ' past-cutoff' : ''}`} data-label="清单截止"><time dateTime={row.cutoff ?? undefined}>{formatSourceDate(row.cutoff, row.cutoff_raw)}</time></td>
          <td className="date-cell listed-cell" data-label="刊载"><time dateTime={row.listed_on ?? undefined}>{formatSourceDate(row.listed_on, row.listed_raw)}</time></td>
          <td className="links-cell"><div className="row-links">{source ? <Link to={openSource(entry, row, source)}>{source.issue.date} 详解</Link> : <Link to={archive(entry, row)}>活动刊载记录</Link>}<SourceLinks urls={row.source_urls} />{showIssue && <span className="row-issue">第 {issueMap.get(entry.issue_id)?.number} 期</span>}</div></td>
        </tr>;
      })}
    </tbody>)}
  </table></div>;
}

function ActivityCards({ matches, favorites, toggle, mode, context, today }: {
  matches: ActivityMatch[]; favorites: Favorites; toggle: (id: string) => void; mode: 'activities' | 'favorites'; context: ReaderLink; today: string;
}) {
  const contextParams = new URLSearchParams(context.search);
  const recordOptions = { q: contextParams.get('q') ?? '', category: contextParams.get('category') ?? '', open: contextParams.get('open') === '1', back: returnKey(context) };
  return <div className="activity-list">{matches.map(({ activity, hits }) => {
    const cutoff = activityCutoff(activity);
    const raw = activity.latestListing?.publication.listings.map(row => row.cutoff_raw).filter(Boolean).join('／') ?? '';
    const hit = hits[0];
    const hitLink = hit ? hit.kind === 'detail' ? sourceLink(hit.issue, hit.source.id, context) : diaryLink(hit.issue.date, 'list', { row: hit.source.id, back: returnKey(context) }) : null;
    return <article className="activity-card" key={activity.id}>
      <div className="entry-heading"><div><span className="category">{activity.categories.filter(Boolean).join(' / ') || '未分类'}</span><h2><Link to={activityLink(activity.id, mode, recordOptions)}>{activity.title}</Link></h2></div><Bookmark id={activity.id} title={activity.title} favorites={favorites} toggle={toggle} /></div>
      <p className="activity-meta"><span>最近刊载 {activity.latestPublication.issue.date}</span><span>{activity.publications.length} 次刊载</span>{activity.latestListing && <span className={cutoff && cutoff < today ? 'past-cutoff' : ''}>最近清单截止 {formatSourceDate(cutoff, raw)}</span>}</p>
      <div className="activity-actions"><Link to={activityLink(activity.id, mode, recordOptions)}>活动详情与刊载历史</Link><span className="muted">{activity.detail ? `详解刊于 ${activity.detail.issue.date}` : '尚未收录原刊详解'}</span></div>
      {hit && hitLink && <p className="search-origin"><Link to={hitLink}>匹配来源：{hit.issue.date} · 第 {hit.issue.number} 期 · {hit.kind === 'detail' ? '原刊正文' : '清单标题'}</Link></p>}
    </article>;
  })}</div>;
}

function ActivityRecord({ activity, favorites, toggle, back, context }: {
  activity: ActivityView; favorites: Favorites; toggle: (id: string) => void; back: ReaderLink; context: ReaderLink;
}) {
  const source = activity.detail;
  return <div className="activity-record">
    <div className="record-title"><div><p className="eyebrow">一个活动 · {activity.publications.length} 次真实刊载</p><h1>{activity.title}</h1></div><Bookmark id={activity.id} title={activity.title} favorites={favorites} toggle={toggle} /></div>
    <p className="context"><Link to={back}>← {returnLabel(back)}</Link> · 最近刊载 {activity.latestPublication.issue.date}</p>
    <section aria-labelledby="activity-body-heading"><h2 id="activity-body-heading">原刊详解</h2>
      {source ? <PrintedArticle message={{ activityId: activity.id, ...source }} favorites={favorites} toggle={toggle} back={back} showFavorite={false} /> : <p className="section-empty">尚未收录这条活动的原刊详解。清单和刊载记录仍保留，不补写正文；可打开原文通知。</p>}
    </section>
    <section className="publication-history" aria-labelledby="publication-heading"><h2 id="publication-heading">刊载历史</h2><ol>{activity.publications.map(({ issue, publication }) => <li key={issue.id}>
      <div className="publication-heading"><Link to={publication.listings.length ? diaryLink(issue.date, 'list', { row: publication.listings[0].id, back: returnKey(context) }) : sourceLink(issue, publication.detail!.id, context)}>{issue.date} · 第 {issue.number} 期</Link><span>{publication.detail ? '本期印有说明' : '仅见清单'}</span></div>
      {publication.listings.map(row => <p key={row.id}>{row.title}<span className="history-date">清单截止 {formatSourceDate(row.cutoff, row.cutoff_raw)} · 原刊载日期 {formatSourceDate(row.listed_on, row.listed_raw)}</span><SourceLinks urls={row.source_urls} /></p>)}
      {publication.detail && <p><Link to={sourceLink(issue, publication.detail.id, context)}>阅读这期实际刊印的说明：{publication.detail.title}</Link></p>}
    </li>)}</ol></section>
  </div>;
}

export default function App() {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [favorites, setFavorites] = useState<Favorites>(readFavorites);
  const [today, setToday] = useState(() => beijingToday());
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const activityMode = location.pathname === '/favorites' ? 'favorites' : 'activities';
  const diaryMode = location.pathname === '/' || location.pathname === '/history';
  const knownPath = diaryMode || ['/activities', '/favorites'].includes(location.pathname);
  const section: DiarySection = params.get('view') === 'list' ? 'list' : 'new';
  const dateParam = params.get('date');
  const selectedDate = isCalendarDate(dateParam) ? dateParam : today;
  const followToday = !isCalendarDate(dateParam);
  const query = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const openOnly = params.get('open') === '1' && (!diaryMode || section === 'list');
  const selectedActivityKey = diaryMode ? null : params.get('activity');

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: 'loading' });
    fetch(`${import.meta.env.BASE_URL}data/catalog.json`, { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error(`无法读取数据（HTTP ${response.status}）`); return response.json() as Promise<unknown>; })
      .then(data => setLoad({ status: 'ready', catalog: parseCatalog(data) }))
      .catch((error: unknown) => { if (!controller.signal.aborted) setLoad({ status: 'error', message: error instanceof Error ? error.message : '无法读取数据' }); });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    let timer: number;
    function refreshDay() {
      clearTimeout(timer);
      setToday(beijingToday());
      const now = Date.now();
      const day = 86400000;
      timer = window.setTimeout(refreshDay, day - ((now + 8 * 3600000) % day) + 100);
    }
    refreshDay();
    window.addEventListener('focus', refreshDay);
    document.addEventListener('visibilitychange', refreshDay);
    return () => { clearTimeout(timer); window.removeEventListener('focus', refreshDay); document.removeEventListener('visibilitychange', refreshDay); };
  }, []);

  const catalog = load.status === 'ready' ? load.catalog : null;
  const issueMap = useMemo(() => new Map(catalog?.issues.map(issue => [issue.id, issue]) ?? []), [catalog]);
  const diaryIndex = useMemo(() => catalog ? buildDiaryIndex(catalog) : new Map<string, DiaryDay>(), [catalog]);
  const detailIndex = useMemo(() => catalog ? indexDetails(catalog) : new Map<string, DatedDetail[]>(), [catalog]);
  const activities = useMemo(() => catalog ? aggregateActivities(catalog) : [], [catalog]);
  const day = diaryDay(diaryIndex, selectedDate);
  const recent = recentRecordedDay(diaryIndex, selectedDate);
  const anyRecordedDate = [...diaryIndex.keys()].sort()[0];
  const favoriteIds = new Set(catalog ? favorites.ids.map(id => resolveIdentity(catalog, id)).filter((id): id is string => id !== null) : []);
  const displayFavorites = { ...favorites, ids: [...favoriteIds] };
  const unknownFavorites = catalog ? favorites.ids.filter(id => !resolveIdentity(catalog, id)) : [];
  const favoriteCount = favoriteIds.size + unknownFavorites.length;
  const aggregateScope = activityMode === 'favorites' ? activities.filter(activity => favoriteIds.has(activity.id)) : activities;
  const activityResults = diaryMode ? [] : searchActivities(aggregateScope, query, category).filter(({ activity }) => !openOnly || !activity.latestListing || activityCutoff(activity) === null || activityCutoff(activity)! >= today);
  const selectedIdentity = catalog && selectedActivityKey ? resolveIdentity(catalog, selectedActivityKey) : null;
  const selectedActivity = selectedIdentity ? activities.find(activity => activity.id === selectedIdentity) : undefined;
  const categories = [...new Set(diaryMode ? day.publications.flatMap(publication => [...publication.listings.map(row => row.category), publication.detail?.category ?? '']) : aggregateScope.flatMap(activity => activity.categories))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const matchedPublications = filterEntries(day.publications, query, category);
  const matchedKeys = new Set(matchedPublications.map(publication => `${publication.issue_id}\0${publication.id}`));
  const printedMessages = day.details.filter(message => matchedKeys.has(`${message.issue.id}\0${message.activityId}`) && (!category || message.detail.category === category));
  const listPublications = openOnly ? openDiaryPublications(matchedPublications, today) : matchedPublications;
  const listingCount = listPublications.reduce((count, publication) => count + publication.listings.filter(row => !category || row.category === category).length, 0);
  const dateContext = { q: query, category, open: openOnly };
  const diaryContext = diaryLink(selectedDate, section, dateContext);
  const aggregateContext = activityLink(null, activityMode, { q: query, category, open: openOnly });
  const currentContext = diaryMode ? diaryContext : selectedActivity ? activityLink(selectedActivity.id, activityMode, { q: query, category, open: openOnly }) : aggregateContext;
  const origin = returnTarget(params.get('back'));
  const back = origin ?? (diaryMode ? diaryLink(selectedDate, 'list') : aggregateContext);
  const legacy = catalog && ['/', '/history', '/favorites'].includes(location.pathname) && !selectedActivityKey ? legacyLocation(catalog, location.pathname, params, today) : null;
  const invalidLegacyIssue = location.pathname === '/history' && !legacy;
  const focusDetail = params.get('detail');
  const focusRow = params.get('row');

  useEffect(() => {
    if (load.status !== 'ready' || !knownPath || legacy) return;
    const target = diaryMode ? document.getElementById(focusDetail ? `detail-${focusDetail}` : focusRow ? `row-${focusRow}` : '') : null;
    if (target) { target.scrollIntoView({ block: 'start' }); target.focus({ preventScroll: true }); }
  }, [load, location.key, focusDetail, focusRow, diaryMode, knownPath, legacy?.search]);

  useEffect(() => {
    if (load.status === 'ready' && !focusDetail && !focusRow) window.scrollTo(0, 0);
  }, [load.status, diaryMode, selectedDate, section, selectedActivityKey]);

  function changeFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    for (const name of ['detail', 'row', 'back', 'missing']) next.delete(name);
    if (value) next.set(key, value); else next.delete(key);
    navigate({ pathname: location.pathname, search: next.size ? `?${next}` : '' }, { replace: key === 'q' });
  }
  function clearFilters() {
    navigate(diaryMode ? diaryLink(followToday ? null : selectedDate, section) : activityLink(null, activityMode));
  }
  function toggleFavorite(id: string) {
    if (favorites.error) return;
    const ids = favoriteIds.has(id) ? favorites.ids.filter(item => !catalog || resolveIdentity(catalog, item) !== id) : [...favorites.ids, id];
    try { localStorage.setItem(storageKey, JSON.stringify(ids)); setFavorites({ ids, error: null }); }
    catch { setFavorites({ ids: favorites.ids, error: '无法保存本地收藏，本次更改未保存。请检查浏览器存储设置。' }); }
  }
  function rowOrigin(row: ListingSource): ReaderLink {
    return diaryLink(selectedDate, 'list', { ...dateContext, row: row.id });
  }
  function rowSource(entry: PublicationView, row: ListingSource, source: DatedDetail): ReaderLink {
    return sourceLink(source.issue, source.detail.id, rowOrigin(row));
  }
  function rowArchive(entry: PublicationView, row: ListingSource): ReaderLink {
    return activityLink(entry.id, 'activities', { back: returnKey(rowOrigin(row)) });
  }

  if (legacy && load.status === 'ready') return <Navigate replace to={legacy} />;

  return <div className="app">
    <header className="header"><div className="header-inner"><NavLink className="brand" to="/"><span className="brand-mark" aria-hidden="true">南</span><span>NannaNews <small>消息阅读</small></span></NavLink><span className="header-note">按日报读新增，按活动查资料</span></div>
      <nav className="navigation" aria-label="主要导航"><div className="nav-inner"><NavLink end to="/">日报</NavLink><NavLink to="/activities">所有活动</NavLink><NavLink to="/favorites">我的收藏<span className="nav-count">{favoriteCount || ''}</span></NavLink></div></nav>
    </header>
    <main className="main">
      {favorites.error && <p className="notice" role="alert">{favorites.error}</p>}
      {load.status === 'loading' && <p className="empty" role="status">正在读取已收录的日报资料…</p>}
      {load.status === 'error' && <div className="empty" role="alert"><h1>资料读取失败</h1><p>{load.message}</p><p>读取失败不表示今天没有新消息。</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></div>}
      {catalog && (!knownPath || invalidLegacyIssue ? <div className="empty"><h1>暂时无法对应这个阅读链接</h1><p>原刊期或消息可能尚未收录，不会替换成其他刊期的内容。</p><Link to="/">回到今天的日报</Link> · <Link to="/activities">查找所有已收录活动</Link></div> : diaryMode ? <>
        <div className="page-heading"><div><p className="eyebrow">{followToday ? '默认跟随北京时间今天' : '按原刊日期阅读'}</p><h1>{selectedDate} 日报</h1></div><span className="issue-stamp">{day.issues.length ? `${day.issues.length} 期已收录` : '暂无已收录日报'}</span></div>
        {origin && <p className="context origin-return"><Link to={origin}>← {returnLabel(origin)}</Link></p>}
        {dateParam && !isCalendarDate(dateParam) && <p className="notice" role="status">链接中的日期无效，当前显示北京时间今天。</p>}
        <DateNavigation index={diaryIndex} day={day} today={today} followToday={followToday} view={section} query={query} category={category} openOnly={openOnly} select={date => navigate(diaryLink(date, section, dateContext))} />
        <nav className="diary-views" aria-label="日报阅读视图"><Link to={diaryLink(followToday ? null : selectedDate, 'new', dateContext)} aria-current={section === 'new' ? 'page' : undefined}>新增消息 <span>{day.state === 'unrecorded' ? '—' : day.details.length}</span></Link><Link to={diaryLink(followToday ? null : selectedDate, 'list', dateContext)} aria-current={section === 'list' ? 'page' : undefined}>原刊清单 <span>{day.state === 'unrecorded' ? '—' : day.publications.reduce((count, pub) => count + pub.listings.length, 0)}</span></Link></nav>
        <p className="context">{day.issues.map(issue => `${issue.date} · 第 ${issue.number} 期`).join('；') || '当前日期没有已收录的日报；不据此推断是否发布或停刊。'}</p>
        {day.state === 'unrecorded' ? <div className="empty unrecorded-day"><h2>{selectedDate === today ? '今天暂无已收录日报' : '这天暂无已收录日报'}</h2><p>这不代表当天没有消息，也不表示已经确认停刊。</p>{(recent || anyRecordedDate) && <Link to={diaryLink(recent ?? anyRecordedDate, section)}>查看{recent ? '最近' : '最早'}已收录日报：{recent ?? anyRecordedDate}</Link>}</div> : <>
          <Filters query={query} category={category} categories={categories} openOnly={openOnly} onChange={changeFilter} clear={clearFilters} showCutoff={section === 'list'} />
          {params.get('missing') && <p className="notice" role="status">该刊期及以前尚未收录这条活动的详解，当前保留原刊清单，不借用后续刊期正文。</p>}
          {focusDetail && !printedMessages.some(message => message.detail.id === focusDetail) && <p className="notice" role="status">这条原刊说明暂时不在当前日期或筛选范围中，可清除筛选或查找活动刊载记录。</p>}
          {section === 'new' ? <section aria-labelledby="new-heading"><div className="section-heading"><div><h2 id="new-heading">当日新增说明</h2><span className="section-count">原刊 {day.details.length} 条 · 当前显示 {printedMessages.length} 条</span></div><span className="section-hint">只列当天实际刊印的正文</span></div>
            {day.state === 'no-new' ? <div className="empty"><h3>已收录日报，无新增说明</h3><p>可以切换到原刊清单查看这期继续刊载的消息。</p></div> : !printedMessages.length ? <div className="empty"><p>当天原刊有新增说明，但当前筛选没有匹配结果。</p><button type="button" onClick={clearFilters}>清除筛选</button></div> : <div className="diary-messages">{day.issues.map(issue => {
              const messages = printedMessages.filter(message => message.issue.id === issue.id);
              if (!messages.length) return null;
              const groups: { category: string; messages: PrintedMessage[] }[] = [];
              for (const message of messages) { const last = groups[groups.length - 1]; if (!last || last.category !== message.detail.category) groups.push({ category: message.detail.category, messages: [] }); groups[groups.length - 1].messages.push(message); }
              return <section key={issue.id}>{day.issues.length > 1 && <h3 className="issue-section">第 {issue.number} 期 · {issue.date}</h3>}{groups.map((group, index) => <section className="detail-category" key={`${group.category}-${index}`}><h3>{group.category || '未分类'}</h3><div className="detail-grid">{group.messages.map(message => <PrintedArticle key={message.detail.id} message={message} favorites={displayFavorites} toggle={toggleFavorite} back={back} archive={activityLink(message.activityId, 'activities', { back: returnKey(diaryContext) })} />)}</div></section>)}</section>;
            })}</div>}
          </section> : <section aria-labelledby="listing-heading"><div className="section-heading"><div><h2 id="listing-heading" tabIndex={-1}>原刊清单</h2><span className="section-count">当前 {listingCount} 行</span></div><span className="section-hint">完整年份 · 原文可追溯</span></div><p className="context">{openOnly ? `按北京时间 ${today} 筛选，截止当天和不确定日期保留；清单截止不代表报名仍开放。` : '默认保留原刊所有清单行；点击标题可阅读本期或注明刊期的历史说明。'}</p>
            {!listingCount ? <div className="empty"><p>{query || category || openOnly ? '当前筛选没有匹配的清单行。' : '已收录日报没有清单行，可查看新增说明。'}</p>{(query || category || openOnly) && <button type="button" onClick={clearFilters}>显示原刊全部清单</button>}</div> : openOnly ? <ListingTable entries={listPublications} issueMap={issueMap} detailIndex={detailIndex} favorites={displayFavorites} toggle={toggleFavorite} today={today} category={category} sourceOrder={false} showIssue={day.issues.length > 1} openSource={rowSource} archive={rowArchive} /> : day.issues.map(issue => {
              const entries = listPublications.filter(pub => pub.issue_id === issue.id);
              if (!entries.some(pub => pub.listings.some(row => !category || row.category === category))) return null;
              return <section className="issue-list" key={issue.id}>{day.issues.length > 1 && <h3 className="issue-section">第 {issue.number} 期 · {issue.date}</h3>}<ListingTable entries={entries} issueMap={issueMap} detailIndex={detailIndex} favorites={displayFavorites} toggle={toggleFavorite} today={today} category={category} sourceOrder showIssue={false} openSource={rowSource} archive={rowArchive} /></section>;
            })}
          </section>}
        </>}
      </> : selectedActivityKey ? selectedActivity ? <ActivityRecord activity={selectedActivity} favorites={displayFavorites} toggle={toggleFavorite} back={back} context={currentContext} /> : <div className="empty"><h1>暂时无法对应这条活动</h1><p>旧身份或资料尚未恢复时，不猜测另一条活动替代它。</p><Link to={aggregateContext}>返回{activityMode === 'favorites' ? '我的收藏' : '所有活动'}</Link></div> : <>
        <div className="page-heading"><div><p className="eyebrow">{activityMode === 'favorites' ? '用户收藏独立于原刊数据' : '按稳定身份聚合，不按刊期重复列出'}</p><h1>{activityMode === 'favorites' ? '我的收藏' : '所有活动'}</h1></div><span className="section-count">{activityMode === 'favorites' ? favoriteIds.size : activities.length} 个已收录活动</span></div>
        <Filters query={query} category={category} categories={categories} openOnly={openOnly} onChange={changeFilter} clear={clearFilters} showCutoff activityMode />
        <p className="context">同一活动只列一次，按最近真实刊载排序。搜索涵盖所有已收录标题和正文；清单截止来自最近一份有清单的刊载，不表示报名仍开放。</p>
        <p className="results-count" role="status">当前匹配 {activityResults.length} 个活动</p>
        {!activityResults.length ? <div className="empty"><p>{query || category || openOnly ? '没有符合筛选条件的活动。' : activityMode === 'favorites' ? (favorites.ids.length ? '已保存的收藏暂时无法对应当前活动，原记录仍保留。' : '还没有收藏的活动，点击收藏按钮即可保存在本机。') : '当前资料中还没有已收录活动。'}</p>{(query || category || openOnly) && <button type="button" onClick={clearFilters}>清除筛选</button>}</div> : <ActivityCards matches={activityResults} favorites={displayFavorites} toggle={toggleFavorite} mode={activityMode} context={aggregateContext} today={today} />}
        {activityMode === 'favorites' && unknownFavorites.length > 0 && <p className="context">{unknownFavorites.length} 条历史收藏暂时无法对应当前活动，原记录已保留，不自动删除。</p>}
      </>)}
      {catalog && <p className="page-footnote">日期导航按原刊刊期，不是活动发生日期。“未收录”不代表没有消息。原刊内容不补写或校对，参与方式请以原始通知为准。</p>}
    </main>
  </div>;
}
