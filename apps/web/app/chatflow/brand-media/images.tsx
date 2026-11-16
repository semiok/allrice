'use client';
import { useEffect, useRef, useState } from 'react';
import type {
  BrandMediaArticle,
  BrandMediaGenerateInput,
  BrandMediaUserCommand,
} from '@allrice/contracts';
import {
  Button,
  Input,
  InlineEditor,
  Modal,
  SegmentedTabs,
  Image,
  imageRequestId,
  retryRequestId,
  runActive,
  ui,
  type BrandMediaClient,
  type BrandMediaRun,
} from './frontend-wiring';
type Scoped<T> = T extends unknown
  ? Omit<T, 'workspaceId' | 'instanceId'>
  : never;
type Command = BrandMediaUserCommand extends infer T
  ? T extends unknown
    ? Omit<T, 'workspaceId' | 'instanceId' | 'requestId'>
    : never
  : never;
type Picture = BrandMediaArticle['images'][number];

export function Images({
  article,
  client,
  sessionId,
  row,
  active,
  generate,
  command,
}: {
  article: BrandMediaArticle;
  client: BrandMediaClient;
  sessionId: string | null;
  row?: BrandMediaRun;
  active: boolean;
  generate: (intent: Scoped<BrandMediaGenerateInput>) => Promise<unknown>;
  command: (input: Command, key: string) => Promise<unknown>;
}) {
  const [target, setTarget] = useState<BrandMediaArticle | null>(null),
    [tab, setTab] = useState<'generate' | 'upload'>('generate'),
    [description, setDescription] = useState(''),
    [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const upload = useRef<{
    file: File;
    requestId: string;
    picture?: Picture;
  } | null>(null);
  const pending = useRef<{
    key: string;
    intent: Scoped<BrandMediaGenerateInput>;
  } | null>(null);
  const lifetime = useRef(0);
  useEffect(
    () => () => {
      lifetime.current++;
    },
    [],
  );
  useEffect(() => {
    if (!active) setTarget(null);
  }, [active]);
  const running = !!row && runActive(row);
  const saved = row?.image;
  const picture: Picture | null =
    tab === 'upload'
      ? (upload.current?.picture ?? null)
      : saved?.file && saved.operationId
        ? {
            source: 'generated',
            file: saved.file,
            operationId: saved.operationId,
          }
        : null;
  const added =
    !!picture &&
    article.images.some(
      (image) => image.file.objectId === picture.file.objectId,
    );
  const work = async (run: () => Promise<unknown>) => {
    if (busy) return;
    const owner = lifetime.current;
    setBusy(true);
    setError('');
    try {
      await run();
    } catch (cause) {
      if (owner === lifetime.current)
        setError(
          cause instanceof Error
            ? cause.message
            : '暂时无法完成，请重试原操作。',
        );
    } finally {
      if (owner === lifetime.current) setBusy(false);
    }
  };
  const create = async () => {
    if (!target || !description.trim() || running) return;
    const intent = {
      operation: 'image' as const,
      articleId: target.id,
      expectedRevision: target.revision,
      description: description.trim(),
      ...(sessionId ? { sessionId } : {}),
    };
    const key = JSON.stringify([intent, row?.run.id ?? 'initial']);
    if (!pending.current || pending.current.key !== key)
      pending.current = {
        key,
        intent: {
          ...intent,
          requestId: await imageRequestId(client.scope, key),
        },
      };
    await generate(pending.current.intent);
    pending.current = null;
  };
  const retry = async () => {
    if (
      !row ||
      !saved?.retryable ||
      row.invocation.intent.operation !== 'image'
    )
      return;
    const {
      workspaceId: _workspace,
      instanceId: _instance,
      ...intent
    } = row.invocation.intent;
    await generate({
      ...intent,
      sessionId: row.sessionId,
      retryOfRunId: row.run.id,
      requestId: await retryRequestId(client.scope, row.run.id),
    });
  };
  const use = async () => {
    if (!target || added) return;
    let chosen = picture;
    if (tab === 'upload') {
      if (!file) return;
      if (upload.current?.file !== file)
        upload.current = { file, requestId: crypto.randomUUID() };
      const entry = upload.current;
      if (!entry.picture) {
        const contentBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]!);
          reader.onerror = () => reject(Error('无法读取图片，请重新选择。'));
          reader.readAsDataURL(entry.file);
        });
        const stored = await client.upload({
          requestId: entry.requestId,
          fileName: entry.file.name,
          mediaType: entry.file.type,
          contentBase64,
        });
        entry.picture = {
          source: 'uploaded',
          origin: 'upload',
          file: { objectId: stored.objectId, checksum: stored.checksum },
        };
      }
      chosen = entry.picture;
    }
    if (!chosen || (tab === 'generate' && !saved?.adoptable)) return;
    await command(
      {
        operation: 'article.image.add',
        articleId: target.id,
        expectedRevision: target.revision,
        image: chosen,
      },
      `image-add:${target.id}:${chosen.file.objectId}`,
    );
    setTarget(null);
  };
  const editable = article.publication.state !== 'published';
  const download = (images: Picture[]) =>
    work(async () => {
      for (const image of images)
        await client.downloadImage(image.file.objectId);
    });
  return (
    <section aria-label="文章配图">
      <div className={ui.actions}>
        <h4>配图 {article.images.length} 张</h4>
        {editable && (
          <Button
            onClick={() => {
              setTarget(article);
              setError('');
              setDescription(
                row?.invocation.intent.operation === 'image'
                  ? row.invocation.intent.description
                  : '',
              );
            }}
          >
            ＋ 加配图
          </Button>
        )}
        {!!article.images.length && (
          <Button
            disabled={busy}
            onClick={() => void download([...article.images])}
          >
            下载全部
          </Button>
        )}
      </div>
      {error && !(active && target && editable) && <p role="alert">{error}</p>}
      <div className={ui.actions}>
        {article.images.map((image, index) => {
          const label = index === 0 ? '封面图' : `配图 ${index}`;
          return (
            <div
              key={image.file.objectId}
              className={ui.item}
              aria-label={label}
            >
              <Image
                client={client}
                objectId={image.file.objectId}
                label={label}
                active={active}
              />
              <p>{label}</p>
              <div className={ui.actions}>
                <Button disabled={busy} onClick={() => void download([image])}>
                  下载
                </Button>
                {editable && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void work(() =>
                        command(
                          {
                            operation: 'article.image.remove',
                            articleId: article.id,
                            expectedRevision: article.revision,
                            ...('origin' in image
                              ? { upload: image.file }
                              : { versionId: image.file.versionId }),
                          },
                          `image-remove:${article.id}:${image.file.objectId}`,
                        ),
                      )
                    }
                  >
                    删除
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {active && target && editable && (
        <Modal
          open
          title="加配图"
          closeLabel="关闭加配图"
          onClose={() => setTarget(null)}
        >
          {error && <p role="alert">{error}</p>}
          <SegmentedTabs
            label="配图来源"
            value={tab}
            onChange={setTab}
            items={[
              {
                value: 'generate',
                id: 'brand-image-generate-tab',
                label: '让 Rice 生成',
                panelId: 'brand-image-generate',
              },
              {
                value: 'upload',
                id: 'brand-image-upload-tab',
                label: '自己上传',
                panelId: 'brand-image-upload',
              },
            ]}
          />
          {tab === 'generate' ? (
            <div id="brand-image-generate" role="tabpanel">
              <InlineEditor
                label="画面描述"
                value={description}
                onChange={setDescription}
                onSave={() => void work(create)}
                onCancel={() => setTarget(null)}
              />
              <div className={ui.actions}>
                <Button
                  variant="primary"
                  disabled={busy || running || !description.trim()}
                  onClick={() => void work(create)}
                >
                  {running ? '生成中…' : row ? '重新生成' : '生成'}
                </Button>
                {running && (
                  <Button
                    disabled={busy}
                    onClick={() => void work(() => client.cancel(row!.run.id))}
                  >
                    取消
                  </Button>
                )}
              </div>
              {row && !running && (
                <p role="status">
                  {saved?.adoptable
                    ? '图片已保留，点击“用这张”才加入文章。'
                    : saved?.status === 'unknown'
                      ? '结果待确认，请先核对原成果。'
                      : saved?.retryable
                        ? '生成失败：Rice 暂时无法生成配图'
                        : saved?.file
                          ? '原图已保留，结果尚未确认。'
                          : '本次没有可采用的图片。'}
                </p>
              )}
              {saved?.retryable && (
                <Button
                  disabled={busy || running}
                  onClick={() => void work(retry)}
                >
                  重试
                </Button>
              )}
              {saved?.file && (
                <>
                  <Image
                    client={client}
                    objectId={saved.file.objectId}
                    label="生成的图"
                    active={active}
                  />
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void download([
                        {
                          source: 'generated',
                          file: saved.file!,
                          operationId: saved.operationId!,
                        },
                      ])
                    }
                  >
                    下载原图
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div id="brand-image-upload" role="tabpanel">
              <Input
                type="file"
                disabled={busy}
                aria-label="选择配图"
                accept="image/png,image/jpeg"
                onChange={(event) => {
                  const selected = event.target.files?.[0] ?? null;
                  if (
                    selected &&
                    !['image/png', 'image/jpeg'].includes(selected.type)
                  ) {
                    setError('请选择 PNG 或 JPG 图片。');
                    return;
                  }
                  setFile(selected);
                  upload.current = null;
                }}
              />
              <p>支持 PNG、JPG。上传的图片存进你的交付成果，只有你能看。</p>
              {file && (
                <Image
                  client={client}
                  localFile={file}
                  label={file.name}
                  active={active}
                />
              )}
            </div>
          )}
          <div className={ui.actions}>
            <Button onClick={() => setTarget(null)}>取消</Button>
            <Button
              variant="primary"
              disabled={
                busy ||
                running ||
                added ||
                (tab === 'generate' ? !saved?.adoptable : !file)
              }
              onClick={() => void work(use)}
            >
              {added ? '已加入' : '用这张'}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
