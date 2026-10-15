'use client';

import { useEffect, useState } from 'react';
import { organizationApi, organizationErrorMessage } from './organization-api';

/** Never render data from a previous person, template, revision or request. */
export function useAdminRead<T>(
  path: string,
  schema: { parse(value: unknown): T },
) {
  const [attempt, setAttempt] = useState(0);
  const key = `${path}/${attempt}`;
  const [result, setResult] = useState<{
    key: string;
    data?: T;
    error?: string;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    void organizationApi(path, 'GET', undefined, controller.signal)
      .then(schema.parse)
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key, data });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setResult({ key, error: organizationErrorMessage(error) });
      });
    return () => controller.abort();
  }, [path, key, schema]);
  return {
    data: result?.key === key ? result.data : undefined,
    error: result?.key === key ? result.error : undefined,
    refresh: () => setAttempt((value) => value + 1),
  };
}
