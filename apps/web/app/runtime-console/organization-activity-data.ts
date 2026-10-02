'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', signal }),
    body = await response.json();
  if (!response.ok)
    throw Error(body.error?.message ?? '暂时无法读取工作动态，请重试。');
  return body;
}
// Refresh the loaded pages without clearing the current list or expanded detail.
export function useActivityPages<T extends object>(
  url: string,
  key?: keyof T,
  cursorName = 'after',
) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const pages = useRef(1),
    abort = useRef<AbortController | null>(null),
    dataRef = useRef<T | null>(null);
  const load = useCallback(
    async (more = false) => {
      if (more && !key) return;
      abort.current?.abort();
      const c = new AbortController();
      abort.current = c;
      setLoading(true);
      setError('');
      try {
        let result: T | null = more ? dataRef.current : null,
          cursor = more
            ? (result as (T & { nextCursor?: string | null }) | null)
                ?.nextCursor
            : null;
        if (more && !cursor) return;
        for (let i = 0; i < (more || !key ? 1 : pages.current); i++) {
          const value = await read<T>(
            url +
              (cursor ? `&${cursorName}=${encodeURIComponent(cursor)}` : ''),
            c.signal,
          );
          if (c.signal.aborted) return;
          result =
            result && key
              ? {
                  ...value,
                  [key]: [
                    ...(result[key] as unknown[]),
                    ...(value[key] as unknown[]),
                  ],
                }
              : value;
          cursor = (value as T & { nextCursor?: string | null }).nextCursor;
          if (!cursor) break;
        }
        if (more) pages.current++;
        dataRef.current = result;
        setData(result);
      } catch (e) {
        if (!c.signal.aborted)
          setError(e instanceof Error ? e.message : '读取失败');
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    },
    [url, key, cursorName],
  );
  useEffect(() => {
    pages.current = 1;
    dataRef.current = null;
    setData(null);
    void load();
    return () => abort.current?.abort();
  }, [load]);
  return { data, error, loading, load };
}
