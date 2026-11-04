import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { loadHistoryDataset, type StaticDataset } from './history/data';
import { searchHistory } from './history/search';
import { loadOriginals, originalUrl, type HistoryOriginals, type HistoryOriginal } from './history/originals';
import type { Catalog, CatalogOccurrence, PublicDate, PublicItemDetail, PublicIssue, PublicOccurrence } from './history/types';
import type { BulletinIssue } from './types';
import { safeSourceUrl } from './reader';
import './history.css';

type Result<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T };
const message = (error: unknown) => error instanceof Error ? error.message : '资料读取失败';
const pageSize = 20;

function External({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children} ↗</a>;
}
function Sources({ urls }: { urls: string[] }) {
  const safe = [...new Set(urls.map(safeSourceUrl).filter((url): url is string => !!url))];
  return <div className="history-links">{safe.map(url => <External key={url} href={url}>{url}</External>)}</div>;
}
function Dates({ dates }: { dates: PublicDate[] }) {
  if (!dates.length) return <p>没有日期记录。</p>;
  return <ul>{dates.map((date, index) => <li key={index}>{date.kind}：{date.raw_text || '原文未明'}{date.normalized_date && ` · 规范日期 ${date.normalized_date}`} · {date.resolution === 'contextual' ? '上下文推定' : date.resolution}{date.literal_source && ` · ${date.literal_source}`}{date.evidence && <p>依据：{date.evidence}</p>}</li>)}</ul>;
}
function OriginalLinks({ manifest, document }: { manifest: HistoryOriginals; document: HistoryOriginal }) {
  return <span className="history-links"><External href={originalUrl(manifest, document)}>GitHub 查看</External><External href={originalUrl(manifest, document, 'raw')}>下载原件</External></span>;
}
function IssueOriginals({ issue, originals }: { issue: PublicIssue; originals: HistoryOriginals }) {
  const bySha = new Map(originals.documents.map(doc => [doc.sha256, doc]));
  return <div><h3>本期关联原件</h3>{issue.documents.length ? <ul>{issue.documents.map(doc => {
    const original = bySha.get(doc.id);
    return <li key={doc.id}>{doc.filename} · {doc.format} {original ? <OriginalLinks manifest={originals} document={original} /> : <span>未在原件清单中找到此 SHA</span>}{doc.warnings.length > 0 && <p>{doc.warnings.join('；')}</p>}</li>;
  })}</ul> : <p>没有明确关联的原件。</p>}</div>;
}
function OccurrenceOriginal({ issue, documentId, originals }: { issue: PublicIssue; documentId: string | null; originals: HistoryOriginals }) {
  const document = issue.documents.find(source => source.id === documentId);
  const original = originals.documents.find(source => source.sha256 === documentId);
  return <div className="history-original-source"><h3>本条记录的原件</h3>
    {document ? <><p>{document.filename} · {document.format} · SHA-256：<code>{document.id}</code></p>
      <p>文件声明日期 {document.claimed_issue_date || '未明'} · 原件识别日期 {document.issue_date || '未明'} · 关联刊期 {issue.issue_date || '未明'}。日期线索不互相替代。</p>
      {original ? <OriginalLinks manifest={originals} document={original} /> : <p>原件尚未登记。</p>}
      {document.warnings.length > 0 && <p>{document.warnings.join('；')}</p>}
    </> : <p>未能对应本条记录的原件，保留来源 SHA：{documentId || '未明'}，不以同刊其他文件代替。</p>}
  </div>;
}
const favoriteContextKeys = ['q', 'category', 'status', 'open', 'year', 'month', 'page'];
function favoriteContext(params: URLSearchParams) {
  const context = new URLSearchParams();
  for (const key of favoriteContextKeys) if (params.has(key)) context.set(key, params.get(key)!);
  return context.toString();
}
function Pager({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <nav className="history-pager" aria-label="分页"><button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button><span>第 {page} / {pages} 页 · {total} 条</span><button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页</button></nav>;
}
function Occurrence({ occurrence, dataset, issue, originals, issueLink }: { occurrence: PublicOccurrence; dataset: StaticDataset; issue?: PublicIssue; originals: HistoryOriginals; issueLink: string }) {
  const review = occurrence.date_review;
  return <section className="history-occurrence" id={`occurrence-${occurrence.id}`}>
    <h3>{occurrence.title}</h3><p>{occurrence.issue_date || '刊期日期未明'} · {occurrence.category || '未分类'} · {occurrence.kind} · 内容状态：{occurrence.content_status === 'verified' ? 'verified（不代表人工核实）' : occurrence.content_status === 'human_verified' ? '人工核实记录' : occurrence.content_status || '未标注'}</p>
    {issue && <p><Link to={issueLink}>查看 {issue.title || '关联刊期'}</Link></p>}
    <h4>历史整理正文</h4><p className="history-body">{occurrence.body_text || '未留存正文。'}</p>
    {occurrence.table_cells.length > 0 && <dl>{occurrence.table_cells.map((cell, index) => <div key={index}><dt>{cell.header}</dt><dd>{cell.text}</dd></div>)}</dl>}
    <h4>来源链接</h4><Sources urls={[...occurrence.source_urls, ...(occurrence.source_corrections ?? []).map(row => row.corrected_url)]} />
    {(occurrence.source_corrections ?? []).map((row, index) => <p key={index}>来源更正：{row.reason} · {row.original_url} → {row.corrected_url} · {row.title} · SHA {row.sha256} · {row.fetched_at}</p>)}
    <h4>日期记录与依据</h4><Dates dates={occurrence.dates} />
    {occurrence.original_dates && <details><summary>原始日期记录</summary><Dates dates={occurrence.original_dates} /></details>}
    {review && <details><summary>日期和来源核验证据</summary><p>{review.status} · {review.reason} {review.rules_version}</p>{review.claims && <Dates dates={review.claims} />}<p>{review.source_review.status} · {review.source_review.reason}</p>{review.source_review.sources.map((source, index) => <div key={index}><Sources urls={[source.url, source.resolved_url]} /><p>{source.title} · SHA {source.sha256} · {source.fetched_at} · {source.published_date || '发布日期未明'}</p>{source.quotes.map((quote, i) => <blockquote key={i}>{quote}</blockquote>)}</div>)}</details>}
    {review?.source_review.activity && <details><summary>来源整理字段与引证（参考）</summary><pre>{JSON.stringify(review.source_review.activity, null, 2)}</pre></details>}
    {(occurrence.locator.page != null || occurrence.locator.anchor) && <p>来源位置：{occurrence.locator.page != null && `第 ${occurrence.locator.page} 页`}{occurrence.locator.anchor && ` · ${occurrence.locator.anchor}`}</p>}
    {occurrence.manual_review && <details><summary>人工记录：{occurrence.manual_review.status}</summary><p>{occurrence.manual_review.reason} · {occurrence.manual_review.reviewed_at} · {occurrence.manual_review.revision}</p>{occurrence.manual_review.activity && <pre>{JSON.stringify(occurrence.manual_review.activity, null, 2)}</pre>}</details>}
    {occurrence.college_mentions.length > 0 && <p>院系记录：{occurrence.college_mentions.map(row => `${row.name}（${row.relation}：${row.evidence}）`).join('；')}</p>}
    {[...occurrence.images, ...(occurrence.primary_images ?? [])].length > 0 && <div className="history-images">{[...occurrence.images, ...(occurrence.primary_images ?? [])].map((image, index) => <figure key={`${image.id}-${index}`}><img src={dataset.assetUrl(image.path)} alt={image.caption || `历史图片 ${index + 1}`} loading="lazy" /><figcaption>{image.caption || '历史图片'}{image.page != null && ` · 第 ${image.page} 页`}</figcaption>{image.source_url && <Sources urls={[image.source_url]} />}</figure>)}</div>}
    {issue && <OccurrenceOriginal issue={issue} documentId={occurrence.document_id} originals={originals} />}
  </section>;
}

export function HistoryArchive({ nativeIssues, favoriteIds, toggleFavorite, favoritesOnly = false, favoritesDisabled = false }: { nativeIssues: BulletinIssue[]; favoriteIds: string[]; toggleFavorite: (id: string) => void; favoritesOnly?: boolean; favoritesDisabled?: boolean }) {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Result<{ dataset: StaticDataset; catalog: Catalog; originals: HistoryOriginals }>>({ status: 'loading' });
  const [searchState, setSearch] = useState<{ key: string; result: Result<string[]> }>({ key: '', result: { status: 'ready', value: [] } });
  const [detailState, setDetail] = useState<{ key: string; result: Result<PublicItemDetail> }>({ key: '', result: { status: 'loading' } });
  const tab = favoritesOnly ? 'favorites' : params.get('tab') || 'activities';
  const itemId = favoritesOnly ? null : params.get('item');
  const occurrenceId = params.get('occurrence');
  const issueId = favoritesOnly ? null : params.get('issue');
  const query = params.get('q') || '';
  const searchKey = `${tab}\0${query}`;
  const search: Result<string[]> = searchState.key === searchKey ? searchState.result : { status: 'loading' };
  const detail: Result<PublicItemDetail> = detailState.key === itemId ? detailState.result : { status: 'loading' };
  const year = params.get('year') || '';
  const month = params.get('month') || '';
  const format = params.get('format') || '';
  const requestedPage = Number(params.get('page'));
  const requested = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  function change(values: Record<string, string | null>, replace = false) {
    const next = new URLSearchParams(params);
    Object.entries(values).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key));
    navigate({ pathname: location.pathname, search: next.size ? `?${next}` : '' }, { replace });
  }
  function link(values: Record<string, string | null>) {
    const next = new URLSearchParams(favoritesOnly ? '' : params);
    if (favoritesOnly) {
      next.set('from', 'favorites');
      const context = favoriteContext(params);
      if (context) next.set('favorite-back', context);
    }
    Object.entries(values).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key));
    return `/archive${next.size ? `?${next}` : ''}`;
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoaded({ status: 'loading' });
    Promise.all([loadHistoryDataset(controller.signal).then(async dataset => ({ dataset, catalog: await dataset.loadCatalog(controller.signal) })), loadOriginals(controller.signal)])
      .then(([data, originals]) => { if (!controller.signal.aborted) setLoaded({ status: 'ready', value: { ...data, originals } }); })
      .catch(error => { if (!controller.signal.aborted) setLoaded({ status: 'error', message: message(error) }); });
    return () => controller.abort();
  }, [attempt]);
  const data = loaded.status === 'ready' ? loaded.value : null;
  useEffect(() => {
    if (!data || !query.trim() || (tab !== 'activities' && tab !== 'favorites')) { setSearch({ key: searchKey, result: { status: 'ready', value: [] } }); return; }
    const controller = new AbortController();
    setSearch({ key: searchKey, result: { status: 'loading' } });
    searchHistory(data.dataset, query.trim(), controller.signal).then(value => { if (!controller.signal.aborted) setSearch({ key: searchKey, result: { status: 'ready', value } }); }).catch(error => { if (!controller.signal.aborted) setSearch({ key: searchKey, result: { status: 'error', message: message(error) } }); });
    return () => controller.abort();
  }, [data, query, tab, searchKey]);
  useEffect(() => {
    if (!data || !itemId) return;
    const controller = new AbortController();
    setDetail({ key: itemId, result: { status: 'loading' } });
    data.dataset.loadItem(itemId, controller.signal).then(value => { if (!controller.signal.aborted) setDetail({ key: itemId, result: { status: 'ready', value } }); }).catch(error => { if (!controller.signal.aborted) setDetail({ key: itemId, result: { status: 'error', message: message(error) } }); });
    return () => controller.abort();
  }, [data, itemId]);
  useEffect(() => {
    if (itemId && occurrenceId && detail.status === 'ready') document.getElementById(`occurrence-${occurrenceId}`)?.scrollIntoView({ block: 'start' });
  }, [itemId, occurrenceId, detail.status]);
  const grouped = useMemo(() => {
    if (!data) return [];
    const matching = !issueId && query.trim() && search.status === 'ready' ? new Set(search.value) : null;
    const favoriteSet = new Set(favoriteIds.map(id => data.dataset.canonicalItemId(id)));
    const rows = new Map<string, CatalogOccurrence[]>();
    for (const occurrence of data.catalog.occurrences) {
      if (matching && !matching.has(occurrence.id)) continue;
      if (favoritesOnly && !favoriteSet.has(occurrence.item_id)) continue;
      if (issueId && occurrence.issue_id !== issueId) continue;
      if (!issueId && year && !occurrence.issue_date?.startsWith(year + '-')) continue;
      if (!issueId && month && occurrence.issue_date?.slice(5, 7) !== month) continue;
      const group = rows.get(occurrence.item_id); if (group) group.push(occurrence); else rows.set(occurrence.item_id, [occurrence]);
    }
    return data.catalog.items.flatMap(item => {
      const occurrences = rows.get(item.id); if (!occurrences?.length) return [];
      const representative = occurrences.find(row => row.id === item.latest_occurrence_id) ?? occurrences[0];
      return [{ item, representative, occurrences }];
    });
  }, [data, search, query, favoriteIds, favoritesOnly, issueId, year, month]);
  if (loaded.status === 'loading') return <p className="empty" role="status">正在读取历史档案目录与原件清单…</p>;
  if (loaded.status === 'error') return <div className="empty" role="alert"><h2>历史档案读取失败</h2><p>{loaded.message}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></div>;
  if (!data) return null;
  const { dataset, originals } = data;
  const issueMap = new Map(dataset.issues.map(issue => [issue.id, issue]));
  const selectedIssue = issueId ? issueMap.get(issueId) : undefined;
  const favoriteFor = (id: string) => favoriteIds.find(saved => dataset.canonicalItemId(saved) === id);
  const bookmark = (id: string, title: string) => <button type="button" className="bookmark" disabled={favoritesDisabled} aria-pressed={!!favoriteFor(id)} aria-label={`${favoriteFor(id) ? '取消收藏' : '收藏'}：${title}`} onClick={() => toggleFavorite(favoriteFor(id) || id)}>{favoriteFor(id) ? '已收藏' : '收藏'}</button>;
  const years = [...new Set(dataset.issues.map(issue => issue.issue_date?.slice(0, 4)).filter((value): value is string => !!value))].sort().reverse();
  const issueRows = dataset.issues.filter(issue => (!year || issue.issue_date?.startsWith(year + '-')) && (!month || issue.issue_date?.slice(5, 7) === month) && (!query || `${issue.title} ${issue.issue_date} ${issue.issue_number}`.toLowerCase().includes(query.toLowerCase())));
  const documents = originals.documents.map(doc => ({ sha: doc.sha256, doc: doc as HistoryOriginal | null, native: nativeIssues.filter(issue => issue.sha256 === doc.sha256) }));
  const bySha = new Map(documents.map(row => [row.sha, row]));
  for (const issue of nativeIssues) {
    if (bySha.has(issue.sha256)) continue;
    const row = { sha: issue.sha256, doc: null, native: nativeIssues.filter(candidate => candidate.sha256 === issue.sha256) };
    documents.push(row); bySha.set(issue.sha256, row);
  }
  const docRows = documents.filter(row => {
    const text = row.doc ? `${row.doc.filename} ${row.doc.format} ${row.sha} ${row.doc.aliases.map(alias => `${alias.filename} ${alias.filename_date} ${alias.content_date} ${alias.date_status}`).join(' ')} ${JSON.stringify(row.doc.registry_metadata)}` : row.native.map(issue => `${issue.filename} ${issue.date} ${issue.number} pdf`).join(' ');
    return (!format || (row.doc?.format || 'pdf') === format) && (!query || text.toLowerCase().includes(query.toLowerCase()));
  });
  const total = tab === 'issues' && !issueId ? issueRows.length : tab === 'originals' ? docRows.length : grouped.length;
  const page = Math.min(requested, Math.max(1, Math.ceil(total / pageSize)));
  const slice = <T,>(rows: T[]) => rows.slice((page - 1) * pageSize, page * pageSize);
  const savedContext = favoriteContext(new URLSearchParams(params.get('favorite-back') || ''));
  const backLink = params.get('from') === 'favorites' && !issueId ? `/favorites${savedContext ? `?${savedContext}` : ''}` : link({ item: null, occurrence: null });
  return <div className="history-archive">
    {!favoritesOnly && <><div className="page-heading"><div><p className="eyebrow">独立历史资料 · 不与现有活动按标题合并</p><h1>历史档案</h1></div></div><p>历史正文为整理资料，日期及状态可能包含推断；不代表当前可报名或人工核实。HTML 原件仅在 GitHub 查看或下载。</p><nav className="history-tabs" aria-label="历史档案导航"><Link to="/archive" aria-current={tab === 'activities' ? 'page' : undefined}>历史活动</Link><Link to="/archive?tab=issues" aria-current={tab === 'issues' ? 'page' : undefined}>历史刊期</Link><Link to="/archive?tab=originals" aria-current={tab === 'originals' ? 'page' : undefined}>全部原件</Link></nav></>}
    {favoritesOnly && <h2>历史档案收藏</h2>}
    {itemId ? <><p><Link to={backLink}>← 返回历史档案</Link></p>{detail.status === 'loading' ? <p role="status">正在读取历史正文…</p> : detail.status === 'error' ? <div role="alert"><p>历史正文读取失败：{detail.message}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></div> : <><div className="history-title"><h2>{detail.value.occurrences.find(row => row.id === occurrenceId)?.title || detail.value.occurrences[0]?.title || detail.value.id}</h2>{bookmark(detail.value.id, detail.value.occurrences[0]?.title || detail.value.id)}</div><p>稳定身份：{detail.value.id} · {detail.value.occurrences.length} 条刊载记录</p>{occurrenceId && !detail.value.occurrences.some(row => row.id === occurrenceId) && <p role="alert">未找到链接指定的刊载记录，以下保留完整历史。</p>}{detail.value.occurrences.map(row => <Occurrence key={row.id} occurrence={row} dataset={dataset} issue={row.issue_id ? issueMap.get(row.issue_id) : undefined} originals={originals} issueLink={link({ tab: 'issues', issue: row.issue_id, item: null, occurrence: null, page: null })} />)}</>}</> : <>
      {selectedIssue && <section className="history-issue"><p><Link to={link({ tab: 'issues', issue: null, page: null })}>← 返回刊期</Link></p><h2>{selectedIssue.title}</h2><p>{selectedIssue.issue_date || '日期未明'} · {selectedIssue.issue_number == null ? '期号未明' : `第 ${selectedIssue.issue_number} 期`} · {selectedIssue.occurrence_count} 条记录</p><IssueOriginals issue={selectedIssue} originals={originals} /><h3>本期活动</h3></section>}
      {issueId && !selectedIssue && <p role="alert">未找到指定刊期，不以其他刊期代替。</p>}
      {!selectedIssue && <div className="history-filters"><label>搜索<input type="search" value={query} onChange={event => change({ q: event.target.value, page: null }, true)} placeholder={tab === 'originals' ? '文件名、别名、日期或 SHA' : tab === 'issues' ? '刊期、日期或期号' : '搜索历史正文'} /></label>{tab !== 'originals' && <><label>年份<select value={year} onChange={event => change({ year: event.target.value, page: null })}><option value="">全部年份</option>{years.map(value => <option key={value}>{value}</option>)}</select></label><label>月份<select value={month} onChange={event => change({ month: event.target.value, page: null })}><option value="">全部月份</option>{Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map(value => <option key={value} value={value}>{value} 月</option>)}</select></label></>}</div>}
      {!selectedIssue && tab === 'originals' && <div className="history-filters"><label>文件格式<select value={format} onChange={event => change({ format: event.target.value, page: null })}><option value="">全部格式</option><option value="html">HTML</option><option value="pdf">PDF</option></select></label></div>}
      {tab === 'originals' ? <>
        <p>按 SHA 去重的历史原件与现有 PDF。文件名、别名和登记日期仅为线索，不据此推断期次。</p>
        <div className="history-list">{slice(docRows).map(row => <article key={row.sha}>
          <h3>{row.doc?.filename || row.native[0].filename}</h3><p>{row.doc?.format || 'pdf'} · SHA-256：<code>{row.sha}</code></p>
          {row.doc ? <><OriginalLinks manifest={originals} document={row.doc} /><p>登记信息（不确定）：声明日期 {row.doc.registry_metadata.claimed_date || '未知'} · 记录刊期日期 {row.doc.registry_metadata.recorded_issue_date || '未知'} · 记录期号 {row.doc.registry_metadata.recorded_issue_number ?? '未知'}</p><details><summary>文件别名及日期线索（{row.doc.aliases.length}）</summary><ul>{row.doc.aliases.map((alias, index) => <li key={index}>{alias.filename} · 文件名日期 {alias.filename_date || '未知'} · 内容日期 {alias.content_date || '未知'} · {alias.date_status}</li>)}</ul></details></> : <><p>现有日报原件（main 分支，文件名不可覆盖）</p><span className="history-links"><External href={`https://github.com/${originals.repository}/blob/main/pdf/${encodeURIComponent(row.native[0].filename)}`}>GitHub 查看</External><External href={`https://raw.githubusercontent.com/${originals.repository}/main/pdf/${encodeURIComponent(row.native[0].filename)}`}>下载原件</External></span></>}
          {row.native.map(issue => <p key={issue.id}>现有日报：{issue.date} · 第 {issue.number} 期</p>)}
          {dataset.issues.filter(issue => issue.documents.some(doc => doc.id === row.sha)).map(issue => <p key={issue.id}><Link to={link({ tab: 'issues', issue: issue.id, q: null, page: null })}>关联历史刊期：{issue.title}</Link></p>)}
        </article>)}</div>
      </> : tab === 'issues' && !issueId ? <div className="history-list">{slice(issueRows).map(issue => <article key={issue.id}><h3><Link to={link({ tab: 'issues', issue: issue.id, page: null })}>{issue.title || '未命名刊期'}</Link></h3><p>{issue.issue_date || '日期未明'} · {issue.issue_number == null ? '期号未明' : `第 ${issue.issue_number} 期`} · {issue.occurrence_count} 条记录</p></article>)}</div> : <>
        {!issueId && query.trim() && search.status === 'loading' ? <p role="status">正在检索历史档案…</p> : !issueId && query.trim() && search.status === 'error' ? <div role="alert"><p>历史搜索失败：{search.message}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></div> : <div className="history-list">{slice(grouped).map(({ item, representative, occurrences }) => <article key={item.id}><div className="history-title"><h3><Link to={link({ tab: issueId ? 'issues' : 'activities', item: item.id, occurrence: representative.id })}>{representative.title}</Link></h3>{bookmark(item.id, representative.title)}</div><p>{representative.issue_date || '日期未明'} · {representative.category || '未分类'} · 共 {item.occurrence_count} 次记录{occurrences.length !== item.occurrence_count && `，当前匹配 ${occurrences.length} 次`}</p><p>{representative.preview}</p></article>)}</div>}
        {favoritesOnly && <p>无法对应的收藏记录仍保存在本机，不会自动删除。</p>}
      </>}
      {!(query.trim() && (tab === 'activities' || tab === 'favorites') && search.status !== 'ready') && <Pager page={page} total={total} onPage={value => change({ page: String(value) })} />}
    </>}
  </div>;
}
