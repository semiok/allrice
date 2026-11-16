'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BrandMediaCandidatesSchema,
  type BrandMediaArticle,
  type BrandMediaTopic,
  type BrandMediaGenerateInput,
  type BrandMediaUserCommand,
} from '@allrice/contracts';
import {
  Button,
  Checkbox,
  Input,
  InlineEditor,
  Modal,
  SegmentedTabs,
  Tag,
  HelpDrawer,
  ui,
  runActive,
  useBrandMediaRunEvents,
  type BrandMediaClient,
  type BrandMediaRun,
} from './frontend-wiring';
type Tab = 'calendar' | 'topics' | 'articles';
type References = BrandMediaTopic['references'];
type Cursor = { createdAt: string; id: string };
const stateNames = { draft: '草稿', scheduled: '已排期', published: '已发布' };
const localDate = (date: Date, timezone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
export function naturalWeeks(month: string) {
  const [year, mm] = month.split('-').map(Number),
    first = new Date(Date.UTC(year!, mm! - 1, 1));
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  const end = new Date(Date.UTC(year!, mm!, 1)),
    weeks: { start: string; end: string }[] = [];
  while (first < end) {
    const last = new Date(first);
    last.setUTCDate(last.getUTCDate() + 6);
    weeks.push({
      start: first.toISOString().slice(0, 10),
      end: last.toISOString().slice(0, 10),
    });
    first.setUTCDate(first.getUTCDate() + 7);
  }
  return weeks;
}
export function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1 + delta, 1)).toISOString().slice(0, 7);
}
/** Input dates use the browser's same local IANA timezone shown beside them.
 * The server resolves calendar month boundaries independently across DST. */
export function localSchedule(value: string, timezone: string) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime()))
    throw Error('请选择有效日期和时间。');
  return { plannedAt: date.toISOString(), timezone };
}
type Scoped<T> = T extends unknown
  ? Omit<T, 'workspaceId' | 'instanceId'>
  : never;
type NoRequest<T> = T extends unknown ? Omit<T, 'requestId'> : never;
export function BrandMediaPanel({
  client,
  sessionId,
  onReturn,
  active = true,
}: {
  client: BrandMediaClient;
  sessionId: string | null;
  onReturn: () => void;
  active?: boolean;
}) {
  const [tab, setTab] = useState<Tab>('calendar'),
    [month, setMonth] = useState(() =>
      localDate(
        new Date(),
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      ).slice(0, 7),
    );
  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    [],
  );
  const [topics, setTopics] = useState<BrandMediaTopic[]>([]),
    [articles, setArticles] = useState<BrandMediaArticle[]>([]),
    [calendar, setCalendar] = useState<BrandMediaArticle[]>([]);
  const [topicCursor, setTopicCursor] = useState<Cursor | null>(null),
    [articleCursor, setArticleCursor] = useState<Cursor | null>(null);
  const [state, setState] = useState<
      'all' | BrandMediaArticle['publication']['state']
    >('all'),
    [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<BrandMediaRun[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [help, setHelp] = useState<string | null>(null),
    [body, setBody] = useState('');
  const [form, setForm] = useState<
    | { kind: 'candidates' }
    | { kind: 'start'; topic: BrandMediaTopic }
    | { kind: 'article'; article: BrandMediaArticle }
    | null
  >(null);
  const [publication, setPublication] = useState<{
    article: BrandMediaArticle;
    kind: 'schedule' | 'publish';
  } | null>(null);
  const [referenceArticle, setReferenceArticle] =
    useState<BrandMediaArticle | null>(null);
  const generation = useRef(0),
    pendingCommands = useRef(
      new Map<
        string,
        { requestId: string; input: Scoped<BrandMediaUserCommand> }
      >(),
    );
  useEffect(() => {
    if (!active) {
      setForm(null);
      setPublication(null);
      setReferenceArticle(null);
      setHelp(null);
    }
  }, [active]);
  const [detail, setDetail] = useState<BrandMediaArticle | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selected =
    detail?.id === selectedId
      ? detail
      : articles.find((article) => article.id === selectedId);
  const reload = useCallback(async () => {
    const version = ++generation.current;
    try {
      const [topicPage, articlePage, schedule, recovery] = await Promise.all([
        client.read({ view: 'topics' }),
        client.read({
          view: 'articles',
          ...(state === 'all' ? {} : { state }),
        }),
        client.read({ view: 'calendar', month, timezone }),
        client.runs(),
      ]);
      if (version !== generation.current) return;
      if (topicPage.view === 'topics') {
        setTopics(topicPage.items);
        setTopicCursor(topicPage.nextCursor);
      }
      if (articlePage.view === 'articles') {
        setArticles(articlePage.items);
        setArticleCursor(articlePage.nextCursor);
        setSelectedId((old) => old ?? articlePage.items[0]?.id ?? null);
        const currentId = selectedIdRef.current;
        if (currentId) {
          const current = await client.read({
            view: 'article',
            articleId: currentId,
          });
          if (
            version === generation.current &&
            current.view === 'article' &&
            selectedIdRef.current === currentId
          )
            setDetail(current.article);
        }
      }
      if (schedule.view === 'calendar') setCalendar(schedule.items);
      setRuns(recovery.runs);
      setError('');
    } catch (cause) {
      if (version === generation.current)
        setError(
          cause instanceof Error ? cause.message : '暂时无法读取，请刷新重试。',
        );
    }
  }, [client, month, timezone, state]);
  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);
  useBrandMediaRunEvents(client, runs, reload, setError);
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    void client
      .read({ view: 'article', articleId: selectedId }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted && result.view === 'article')
          setDetail(result.article);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [client, selectedId]);
  useEffect(() => {
    const controller = new AbortController();
    setBody('');
    if (selected?.body)
      void client
        .body(selected.body, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setBody(value);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setError(cause.message);
        });
    return () => controller.abort();
  }, [client, selected?.id, selected?.body?.objectId]);
  const command = async (
    input: NoRequest<Scoped<BrandMediaUserCommand>>,
    key: string,
  ) => {
    const previous = pendingCommands.current.get(key);
    const request =
      previous &&
      JSON.stringify({ ...previous.input, requestId: undefined }) ===
        JSON.stringify({ ...input, requestId: undefined })
        ? previous
        : {
            requestId: crypto.randomUUID(),
            input: { ...input, requestId: '' } as Scoped<BrandMediaUserCommand>,
          };
    request.input = {
      ...input,
      requestId: request.requestId,
    } as Scoped<BrandMediaUserCommand>;
    pendingCommands.current.set(key, request);
    setBusy(true);
    setError('');
    try {
      const result = await client.command(request.input);
      if (result.kind === 'deleted' && selectedIdRef.current === result.id) {
        selectedIdRef.current = null;
        setSelectedId(null);
        setDetail(null);
      }
      await reload();
      return result;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : '保存失败，请重试原操作。',
      );
      throw cause;
    } finally {
      setBusy(false);
    }
  };
  const act = (input: Parameters<typeof command>[0], key: string) => {
    void command(input, key).catch(() => {});
  };
  const candidatesRun = runs.find(
    (row) => row.invocation.intent.operation === 'candidates',
  );
  const articleRun =
    selected &&
    runs.find(
      (row) =>
        row.invocation.intent.operation === 'article' &&
        row.invocation.intent.articleId === selected.id,
    );
  const candidateDeliveries =
    candidatesRun?.deliveries
      .filter((delivery) => delivery.format === 'json')
      .flatMap((delivery) => {
        try {
          return BrandMediaCandidatesSchema.parse(JSON.parse(delivery.content))
            .candidates;
        } catch {
          return [];
        }
      }) ?? [];
  const generate = async (intent: Scoped<BrandMediaGenerateInput>) => {
    const result = await client.generate(intent);
    // The receipt identifies this new Run, including follow-up queueing.
    // Preserve its native facts even if the subsequent cold read fails.
    setRuns((old) => [
      {
        run: result.run,
        sessionId: result.userMessage.sessionId,
        invocation: result.invocation,
        deliveries: [],
        submission: null,
      },
      ...old.filter((row) => row.run.id !== result.run.id),
    ]);
    await reload();
    return result;
  };
  const openArticle = (article: BrandMediaArticle) => {
    setState('all');
    setArticles((old) =>
      old.some((item) => item.id === article.id) ? old : [article, ...old],
    );
    setDetail(article);
    selectedIdRef.current = article.id;
    setSelectedId(article.id);
    setTab('articles');
  };
  const pageMore = async (view: 'topics' | 'articles') => {
    const cursor = view === 'topics' ? topicCursor : articleCursor;
    if (!cursor || busy) return;
    const version = generation.current;
    setBusy(true);
    try {
      const result = await client.read(
        view === 'topics'
          ? { view, cursor }
          : { view, cursor, ...(state === 'all' ? {} : { state }) },
      );
      if (version !== generation.current) return;
      if (result.view === 'topics') {
        setTopics((old) => [
          ...old,
          ...result.items.filter(
            (item) => !old.some((previous) => previous.id === item.id),
          ),
        ]);
        setTopicCursor(result.nextCursor);
      }
      if (result.view === 'articles') {
        setArticles((old) => [
          ...old,
          ...result.items.filter(
            (item) => !old.some((previous) => previous.id === item.id),
          ),
        ]);
        setArticleCursor(result.nextCursor);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取失败');
    } finally {
      setBusy(false);
    }
  };
  const renderGeneration = (value: NonNullable<typeof form>) => (
    <GenerationForm
      key={
        value.kind +
        ('article' in value
          ? value.article.id + ':' + value.article.revision
          : 'topic' in value
            ? value.topic.id
            : '')
      }
      form={value}
      client={client}
      sessionId={sessionId}
      active={active}
      running={runs.find((row) =>
        value.kind === 'candidates'
          ? row.invocation.intent.operation === 'candidates'
          : 'article' in value &&
            row.invocation.intent.operation === 'article' &&
            row.invocation.intent.articleId === value.article.id,
      )}
      onClose={() => setForm(null)}
      generate={generate}
      start={async (topic, requirements, references) => {
        const result = await command(
          {
            operation: 'article.start',
            topicId: topic.id,
            expectedRevision: topic.revision,
            requirements,
            references,
          },
          'start:' + topic.id,
        );
        if (result?.kind !== 'article') throw Error('文章未创建');
        openArticle(result.article);
        return result.article;
      }}
      onStarted={() => {
        if (value.kind === 'start') setForm(null);
        setNotice('已交给当前员工生成，可以回到对话。');
      }}
    />
  );
  return (
    <section className={ui.page} aria-label="品牌自媒体">
      <header className={ui.header}>
        <Button data-brand-return onClick={onReturn}>
          ← 回到对话
        </Button>
        <strong className={ui.brand}>品牌自媒体</strong>
        <SegmentedTabs
          className={ui.tabs}
          label="品牌自媒体页面"
          value={tab}
          onChange={setTab}
          items={[
            {
              value: 'calendar',
              label: '排期表',
              id: 'brand-calendar-tab',
              panelId: 'brand-calendar',
            },
            {
              value: 'topics',
              label: '选题库',
              id: 'brand-topics-tab',
              panelId: 'brand-topics',
            },
            {
              value: 'articles',
              label: '文章库',
              id: 'brand-articles-tab',
              panelId: 'brand-articles',
            },
          ]}
        />
        <Button
          onClick={() => {
            void client
              .help()
              .then((value) => setHelp(value.content))
              .catch((cause) => setError(cause.message));
          }}
        >
          ⓘ 使用说明
        </Button>
      </header>
      {error && (
        <p role="alert">
          {error} <Button onClick={() => void reload()}>刷新</Button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className={ui.content}>
        {tab === 'calendar' && (
          <section
            id="brand-calendar"
            role="tabpanel"
            aria-labelledby="brand-calendar-tab"
          >
            <div className={ui.actions}>
              <Button
                aria-label="上个月"
                onClick={() => setMonth(shiftMonth(month, -1))}
              >
                ←
              </Button>
              <h3>{month}</h3>
              <Button
                aria-label="下个月"
                onClick={() => setMonth(shiftMonth(month, 1))}
              >
                →
              </Button>
              <span>{timezone}</span>
            </div>
            <div className={ui.calendar}>
              {naturalWeeks(month).map((week, index) => {
                const today = localDate(new Date(), timezone),
                  items = calendar.filter(
                    (article) =>
                      article.publication.schedule &&
                      localDate(
                        new Date(article.publication.schedule.plannedAt),
                        timezone,
                      ) >= week.start &&
                      localDate(
                        new Date(article.publication.schedule.plannedAt),
                        timezone,
                      ) <= week.end,
                  );
                return (
                  <div
                    className={ui.week}
                    data-current={today >= week.start && today <= week.end}
                    key={week.start}
                  >
                    <div className={ui.weekLabel}>
                      <strong>第 {index + 1} 周</strong>
                      <p>
                        {week.start.slice(5)} — {week.end.slice(5)}
                      </p>
                      <p>周一 — 周日</p>
                    </div>
                    <div className={ui.weekItems}>
                      {items.length ? (
                        items.map((article) => (
                          <div key={article.id} className={ui.event}>
                            <span>
                              {new Intl.DateTimeFormat('zh-CN', {
                                timeZone: timezone,
                                day: 'numeric',
                                weekday: 'short',
                                hour: '2-digit',
                                minute: '2-digit',
                              }).format(
                                new Date(
                                  article.publication.schedule!.plannedAt,
                                ),
                              )}
                            </span>
                            <Button onClick={() => openArticle(article)}>
                              {article.title}
                            </Button>
                            <Tag>{stateNames[article.publication.state]}</Tag>
                          </div>
                        ))
                      ) : (
                        <p>这周还没有排期</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
        {tab === 'topics' && (
          <section
            id="brand-topics"
            role="tabpanel"
            aria-labelledby="brand-topics-tab"
          >
            {form?.kind === 'candidates' ? (
              renderGeneration(form)
            ) : (
              <div className={ui.actions}>
                <h3>
                  {topicCursor
                    ? `已加载 ${topics.length} 个选题`
                    : `${topics.length} 个选题`}
                </h3>
                <Button
                  variant="primary"
                  onClick={() => setForm({ kind: 'candidates' })}
                >
                  ＋ 想选题
                </Button>
              </div>
            )}
            {form?.kind === 'candidates' && candidatesRun && (
              <RunStatus
                row={candidatesRun}
                client={client}
                refresh={reload}
                onRetry={() => setForm({ kind: 'candidates' })}
              />
            )}
            {form?.kind === 'candidates' &&
              candidateDeliveries.map((candidate, index) => (
                <article key={index} className={ui.item}>
                  <h4>{candidate.title}</h4>
                  <p>{candidate.summary}</p>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      const intent = candidatesRun!.invocation.intent;
                      if (intent.operation !== 'candidates') return;
                      act(
                        {
                          operation: 'topic.add',
                          candidate,
                          direction: intent.direction,
                          references: intent.references,
                          sourceRunId: candidatesRun!.run.id,
                        },
                        `candidate:${candidatesRun!.run.id}:${index}`,
                      );
                    }}
                  >
                    加入选题库
                  </Button>
                </article>
              ))}
            {form?.kind !== 'candidates' && !topics.length && (
              <p>还没有选题，先写一句方向，让当前员工想几个候选。</p>
            )}
            {form?.kind !== 'candidates' &&
              topics.map((topic) => (
                <article className={ui.item} key={topic.id}>
                  <h4>{topic.candidate.title}</h4>
                  <p>{topic.candidate.summary}</p>
                  <div className={ui.actions}>
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => setForm({ kind: 'start', topic })}
                    >
                      写正文
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        act(
                          {
                            operation: 'topic.delete',
                            topicId: topic.id,
                            expectedRevision: topic.revision,
                          },
                          'topic-delete:' + topic.id,
                        )
                      }
                    >
                      删除选题
                    </Button>
                  </div>
                </article>
              ))}
            {form?.kind !== 'candidates' && topicCursor && (
              <Button disabled={busy} onClick={() => void pageMore('topics')}>
                加载更多选题
              </Button>
            )}
          </section>
        )}
        {tab === 'articles' && (
          <section
            id="brand-articles"
            role="tabpanel"
            aria-labelledby="brand-articles-tab"
          >
            <div className={ui.actions}>
              {(['all', 'draft', 'scheduled', 'published'] as const).map(
                (value) => (
                  <Button
                    key={value}
                    aria-pressed={state === value}
                    onClick={() => setState(value)}
                  >
                    {value === 'all' ? '全部' : stateNames[value]}
                  </Button>
                ),
              )}
            </div>
            <div className={ui.split}>
              <div className={ui.articleList}>
                {articles.length ? (
                  articles.map((article) => (
                    <div className={ui.item} key={article.id}>
                      <Button
                        aria-pressed={selectedId === article.id}
                        onClick={() => setSelectedId(article.id)}
                      >
                        {article.title}
                      </Button>
                      <Tag>{stateNames[article.publication.state]}</Tag>
                    </div>
                  ))
                ) : (
                  <p>还没有文章，从选题开始写正文。</p>
                )}
                {articleCursor && (
                  <Button
                    disabled={busy}
                    onClick={() => void pageMore('articles')}
                  >
                    加载更多文章
                  </Button>
                )}
              </div>
              <article className={ui.articleDetail}>
                {selected && (
                  <>
                    <header className={ui.header}>
                      <h3>{selected.title}</h3>
                      <Tag>{stateNames[selected.publication.state]}</Tag>
                      {selected.publication.state === 'published' ? (
                        <Button
                          disabled={busy}
                          onClick={() =>
                            act(
                              {
                                operation: 'article.publication',
                                articleId: selected.id,
                                expectedRevision: selected.revision,
                                change: { action: 'unpublish' },
                              },
                              'unpublish:' + selected.id,
                            )
                          }
                        >
                          改回已排期
                        </Button>
                      ) : (
                        <>
                          <Button
                            disabled={busy}
                            onClick={() =>
                              setPublication({
                                article: selected,
                                kind: 'schedule',
                              })
                            }
                          >
                            {selected.publication.state === 'scheduled'
                              ? '修改排期'
                              : '排期'}
                          </Button>
                          {selected.publication.state === 'scheduled' && (
                            <>
                              <Button
                                disabled={busy}
                                onClick={() =>
                                  act(
                                    {
                                      operation: 'article.publication',
                                      articleId: selected.id,
                                      expectedRevision: selected.revision,
                                      change: { action: 'unschedule' },
                                    },
                                    'unschedule:' + selected.id,
                                  )
                                }
                              >
                                取消排期
                              </Button>
                              <Button
                                variant="primary"
                                onClick={() =>
                                  setPublication({
                                    article: selected,
                                    kind: 'publish',
                                  })
                                }
                              >
                                标记已发布
                              </Button>
                            </>
                          )}
                        </>
                      )}
                    </header>
                    {articleRun && (
                      <RunStatus
                        row={articleRun}
                        client={client}
                        refresh={reload}
                        onRetry={() =>
                          setForm({ kind: 'article', article: selected })
                        }
                      />
                    )}
                    <div className={ui.body} aria-label="文章正文">
                      {body ||
                        (selected.body ? '正在读取正文…' : '正文还未生成')}
                    </div>
                    {articleRun?.deliveries.map((delivery) => (
                      <p key={delivery.file.versionId}>
                        <a
                          href={`/api/v1/files/${delivery.file.objectId}/download?workspaceId=${client.scope.workspaceId}`}
                        >
                          查看本次正文成果
                        </a>
                      </p>
                    ))}
                    {selected.publication.schedule && (
                      <p>
                        排期：
                        {new Intl.DateTimeFormat('zh-CN', {
                          timeZone: selected.publication.schedule.timezone,
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }).format(
                          new Date(selected.publication.schedule.plannedAt),
                        )}{' '}
                        · {selected.publication.schedule.timezone}
                      </p>
                    )}
                    {selected.publication.links && (
                      <p>
                        {selected.publication.links.wechat && (
                          <a href={selected.publication.links.wechat}>
                            公众号文章
                          </a>
                        )}{' '}
                        {selected.publication.links.xiaohongshu && (
                          <a href={selected.publication.links.xiaohongshu}>
                            小红书笔记
                          </a>
                        )}
                      </p>
                    )}
                    <p>参考资料：{selected.references.length} 份</p>
                    {selected.publication.state !== 'published' && (
                      <div className={ui.actions}>
                        {renderGeneration({
                          kind: 'article',
                          article: selected,
                        })}
                        <Button
                          disabled={busy}
                          onClick={() => setReferenceArticle(selected)}
                        >
                          添加参考资料
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() =>
                            act(
                              {
                                operation: 'article.delete',
                                articleId: selected.id,
                                expectedRevision: selected.revision,
                              },
                              'article-delete:' + selected.id,
                            )
                          }
                        >
                          删除这篇文章
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </article>
            </div>
          </section>
        )}
      </div>
      {active && form?.kind === 'start' && renderGeneration(form)}
      {active && publication && (
        <PublicationForm
          value={publication}
          timezone={timezone}
          onClose={() => setPublication(null)}
          onSave={async (change) => {
            await command(
              {
                operation: 'article.publication',
                articleId: publication.article.id,
                expectedRevision: publication.article.revision,
                change,
              },
              'publication:' + publication.article.id,
            );
            setPublication(null);
          }}
        />
      )}
      {active && referenceArticle && (
        <ReferencePicker
          client={client}
          initial={referenceArticle.references}
          onClose={() => setReferenceArticle(null)}
          onSave={async (references) => {
            await command(
              {
                operation: 'article.references',
                articleId: referenceArticle.id,
                expectedRevision: referenceArticle.revision,
                references,
              },
              'references:' + referenceArticle.id,
            );
            setReferenceArticle(null);
          }}
        />
      )}
      {active && help !== null && (
        <HelpDrawer content={help} onClose={() => setHelp(null)} />
      )}
    </section>
  );
}
function RunStatus({
  row,
  client,
  refresh,
  onRetry,
}: {
  row: BrandMediaRun;
  client: BrandMediaClient;
  refresh: () => Promise<void>;
  onRetry: () => void;
}) {
  const [error, setError] = useState('');
  return (
    <div role="status">
      {runActive(row) ? (
        <>
          <span>
            {row.run.status === 'queued' ? '已排队，等待当前员工' : '生成中…'}
          </span>
          <Button
            onClick={() => {
              void client
                .cancel(row.run.id)
                .then(refresh)
                .catch((cause) => setError(cause.message));
            }}
          >
            取消
          </Button>
        </>
      ) : row.run.status === 'succeeded' ? (
        <span>
          {row.submission
            ? row.submission.articleUpdated
              ? `本次正文已保存（版本 ${row.submission.revision}）`
              : '本次正文成果已保留，文章未更新，请核对当前文章。'
            : '本次生成已完成'}
        </span>
      ) : (
        <>
          <span>
            {row.run.status === 'canceled'
              ? '已取消生成'
              : '生成失败：' + (row.run.error?.message ?? '暂时无法完成')}
          </span>
          <Button onClick={onRetry}>重试</Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
function GenerationForm({
  form,
  client,
  sessionId,
  onClose,
  generate,
  start,
  onStarted,
  running,
  active,
}: {
  form:
    | { kind: 'candidates' }
    | { kind: 'start'; topic: BrandMediaTopic }
    | { kind: 'article'; article: BrandMediaArticle };
  client: BrandMediaClient;
  sessionId: string | null;
  onClose: () => void;
  generate: (input: Scoped<BrandMediaGenerateInput>) => Promise<unknown>;
  start: (
    topic: BrandMediaTopic,
    requirements: string,
    references: References,
  ) => Promise<BrandMediaArticle>;
  onStarted: () => void;
  running?: BrandMediaRun;
  active: boolean;
}) {
  const [text, setText] = useState(''),
    [references, setReferences] = useState<References>(
      form.kind === 'start'
        ? form.topic.references
        : form.kind === 'article'
          ? form.article.references
          : [],
    ),
    [picker, setPicker] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<{
      digest: string;
      input: Scoped<BrandMediaGenerateInput>;
    } | null>(null),
    started = useRef<BrandMediaArticle | null>(null);
  useEffect(() => {
    if (!active) setPicker(false);
  }, [active]);
  const submit = async () => {
    if (
      (form.kind !== 'start' && !text.trim()) ||
      busy ||
      (running && runActive(running))
    )
      return;
    setBusy(true);
    setError('');
    try {
      let article = form.kind === 'article' ? form.article : started.current;
      if (form.kind === 'start' && !article) {
        article = await start(form.topic, text, references);
        started.current = article;
      }
      const intent =
        form.kind === 'candidates'
          ? {
              operation: 'candidates' as const,
              direction: text,
              references,
              ...(sessionId ? { sessionId } : {}),
            }
          : {
              operation: 'article' as const,
              articleId: article!.id,
              expectedRevision: article!.revision,
              instructions: text.trim() || '根据这个选题和已选资料写正文。',
              references,
              ...(sessionId ? { sessionId } : {}),
            };
      const digest = JSON.stringify(intent);
      if (!pending.current || pending.current.digest !== digest)
        pending.current = {
          digest,
          input: { ...intent, requestId: crypto.randomUUID() },
        };
      await generate(pending.current.input);
      pending.current = null;
      if (form.kind === 'article') setText('');
      onStarted();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : '请求失败，请重试同一次生成。',
      );
    } finally {
      setBusy(false);
    }
  };
  const controls = (
    <>
      <p>
        {form.kind === 'candidates'
          ? '写一句方向，让当前员工给几个候选，挑中的再加入选题库。'
          : form.kind === 'start'
            ? '补充本次写作要求，正文由当前员工生成。'
            : '告诉 Rice 怎么改'}
      </p>
      <InlineEditor
        value={text}
        label={
          form.kind === 'candidates'
            ? '内容方向'
            : form.kind === 'start'
              ? '补充写作要求（可选）'
              : '修改意见'
        }
        onChange={setText}
        onSave={() => void submit()}
        onCancel={() => {
          setText('');
          if (form.kind !== 'article') onClose();
        }}
      />
      {form.kind !== 'article' && (
        <p>
          参考资料：{references.length} 份{' '}
          <Button
            disabled={busy || !!started.current}
            onClick={() => setPicker(true)}
          >
            添加参考资料
          </Button>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {active && picker && (
        <ReferencePicker
          client={client}
          initial={references}
          onClose={() => setPicker(false)}
          onSave={async (value) => {
            setReferences(value);
            setPicker(false);
          }}
        />
      )}
    </>
  );
  const button = (
    <Button
      variant={form.kind === 'article' ? 'outline' : 'primary'}
      disabled={
        busy ||
        (!!running && runActive(running)) ||
        (form.kind !== 'start' && !text.trim())
      }
      onClick={() => void submit()}
    >
      {busy
        ? '正在提交…'
        : form.kind === 'start'
          ? '开始写'
          : form.kind === 'article'
            ? '修改'
            : '让 Rice 想选题 / 换一批'}
    </Button>
  );
  if (form.kind === 'start')
    return (
      <Modal
        open
        title="写正文"
        closeLabel="关闭"
        onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>取消</Button>
            {button}
          </>
        }
      >
        {controls}
      </Modal>
    );
  return (
    <section aria-label={form.kind === 'candidates' ? '想选题' : '修改正文'}>
      {form.kind === 'candidates' && (
        <header className={ui.header}>
          <Button onClick={onClose}>← 选题库</Button>
          <h3>想选题</h3>
        </header>
      )}
      {controls}
      {button}
    </section>
  );
}

function PublicationForm({
  value,
  timezone,
  onClose,
  onSave,
}: {
  value: { article: BrandMediaArticle; kind: 'schedule' | 'publish' };
  timezone: string;
  onClose: () => void;
  onSave: (
    change: Extract<
      BrandMediaUserCommand,
      { operation: 'article.publication' }
    >['change'],
  ) => Promise<void>;
}) {
  const [date, setDate] = useState(''),
    [wechat, setWechat] = useState(''),
    [xiaohongshu, setXiaohongshu] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSave(
        value.kind === 'schedule'
          ? { action: 'schedule', schedule: localSchedule(date, timezone) }
          : {
              action: 'publish',
              links: {
                wechat: wechat.trim() || null,
                xiaohongshu: xiaohongshu.trim() || null,
              },
            },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={value.kind === 'schedule' ? '排期' : '标记已发布'}
      closeLabel="关闭"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            保存
          </Button>
        </>
      }
    >
      {value.kind === 'schedule' ? (
        <>
          <p>{timezone}</p>
          <Input
            type="datetime-local"
            aria-label="计划发布时间"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </>
      ) : (
        <>
          <p>请先在对应平台完成发布，再登记链接。</p>
          <Input
            type="url"
            aria-label="公众号文章链接（选填）"
            placeholder="公众号文章链接（选填）"
            value={wechat}
            onChange={(event) => setWechat(event.target.value)}
          />
          <Input
            type="url"
            aria-label="小红书笔记链接（选填）"
            placeholder="小红书笔记链接（选填）"
            value={xiaohongshu}
            onChange={(event) => setXiaohongshu(event.target.value)}
          />
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </Modal>
  );
}
function ReferencePicker({
  client,
  initial,
  onClose,
  onSave,
}: {
  client: BrandMediaClient;
  initial: References;
  onClose: () => void;
  onSave: (value: References) => Promise<void>;
}) {
  type Page = Awaited<ReturnType<BrandMediaClient['references']>>;
  const [tab, setTab] = useState<'enterprise' | 'upload'>('enterprise'),
    [query, setQuery] = useState(''),
    [rows, setRows] = useState<Page['references']>([]),
    [cursor, setCursor] = useState<Page['nextCursor']>(null);
  const [selected, setSelected] = useState(initial),
    [file, setFile] = useState<File | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const upload = useRef<{
    file: File;
    request: {
      requestId: string;
      fileName: string;
      mediaType: string;
      contentBase64: string;
    };
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setRows([]);
    setCursor(null);
    void client
      .references(query, undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          if (value.viewerId !== client.scope.ownerId)
            throw Error('资料身份已变化');
          setRows(value.references);
          setCursor(value.nextCursor);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [client, query]);
  const more = async () => {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const result = await client.references(query, cursor);
      setRows((old) => [
        ...old,
        ...result.references.filter(
          (row) => !old.some((item) => item.revisionId === row.revisionId),
        ),
      ]);
      setCursor(result.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '资料读取失败');
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (tab === 'upload' && file) {
        if (upload.current?.file !== file) {
          const contentBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(Error('文件读取失败'));
            reader.onload = () =>
              resolve(String(reader.result).split(',')[1] ?? '');
            reader.readAsDataURL(file);
          });
          upload.current = {
            file,
            request: {
              requestId: crypto.randomUUID(),
              fileName: file.name,
              mediaType: file.type || 'application/octet-stream',
              contentBase64,
            },
          };
        }
        const uploaded = await client.uploadReference(upload.current.request);
        await onSave([
          ...selected.filter(
            (pin) =>
              pin.origin !== 'upload' ||
              pin.file.objectId !== uploaded.objectId,
          ),
          {
            origin: 'upload',
            file: { objectId: uploaded.objectId, checksum: uploaded.checksum },
          },
        ]);
      } else {
        const pins = await Promise.all(
          selected.map(async (pin) => {
            if (pin.origin !== 'reference') return pin;
            const row = rows.find((row) => row.revisionId === pin.revisionId);
            return row ? client.selectReference(row) : pin;
          }),
        );
        await onSave(pins);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '资料保存失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title="添加参考资料"
      closeLabel="关闭参考资料"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={busy || (tab === 'upload' && !file)}
            onClick={() => void save()}
          >
            {tab === 'upload' ? '上传并添加' : '添加所选资料'}
          </Button>
        </>
      }
    >
      <SegmentedTabs
        label="参考资料来源"
        value={tab}
        onChange={setTab}
        items={[
          {
            value: 'enterprise',
            label: '企业资料',
            id: 'brand-refs-enterprise-tab',
            panelId: 'brand-refs-enterprise',
          },
          {
            value: 'upload',
            label: '上传文件',
            id: 'brand-refs-upload-tab',
            panelId: 'brand-refs-upload',
          },
        ]}
      />
      {tab === 'enterprise' ? (
        <div
          role="tabpanel"
          id="brand-refs-enterprise"
          aria-labelledby="brand-refs-enterprise-tab"
        >
          <Input
            aria-label="搜索企业资料"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索资料"
          />
          {rows
            .filter(
              (row) =>
                row.status === 'active' &&
                row.canReference &&
                !row.companyTemplate,
            )
            .map((row) => (
              <div key={row.revisionId}>
                <Checkbox
                  disabled={busy}
                  label={row.fileName + ' · v' + row.revision}
                  checked={selected.some(
                    (pin) =>
                      pin.origin === 'reference' &&
                      pin.sourceId === row.sourceId &&
                      pin.revisionId === row.revisionId,
                  )}
                  onChange={(checked) =>
                    setSelected((old) => [
                      ...old.filter(
                        (pin) =>
                          pin.origin !== 'reference' ||
                          pin.sourceId !== row.sourceId,
                      ),
                      ...(checked
                        ? [
                            {
                              origin: 'reference' as const,
                              sourceId: row.sourceId,
                              revisionId: row.revisionId,
                            },
                          ]
                        : []),
                    ])
                  }
                />
                <Tag>
                  {row.publication?.audience.scope === 'company'
                    ? '公司'
                    : row.publication?.audience.scope === 'departments'
                      ? '部门'
                      : '个人'}
                </Tag>
              </div>
            ))}
          {!rows.length && <p>暂无可选择的资料</p>}
          {cursor && (
            <Button disabled={busy} onClick={() => void more()}>
              加载更多资料
            </Button>
          )}
        </div>
      ) : (
        <div
          role="tabpanel"
          id="brand-refs-upload"
          aria-labelledby="brand-refs-upload-tab"
        >
          <Input
            type="file"
            aria-label="上传参考文件"
            disabled={busy}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <p>文件会保存到你的交付成果，作为这次的参考资料。</p>
        </div>
      )}
      {initial
        .filter((pin) => pin.origin !== 'reference')
        .map((pin) => (
          <Checkbox
            key={pin.file.objectId}
            label={'已选文件 ' + pin.file.objectId}
            checked={selected.some(
              (value) =>
                value.origin !== 'reference' &&
                value.file.objectId === pin.file.objectId,
            )}
            onChange={(checked) =>
              setSelected((old) =>
                checked
                  ? [...old, pin]
                  : old.filter(
                      (value) =>
                        value.origin === 'reference' ||
                        value.file.objectId !== pin.file.objectId,
                    ),
              )
            }
          />
        ))}
      {error && <p role="alert">{error}</p>}
    </Modal>
  );
}
