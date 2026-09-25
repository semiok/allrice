import { memo, useMemo } from 'react';
import {
  MarkdownText,
  type MarkdownLabels,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { WorkbenchArtifact } from '@allrice/contracts';
import { markdownDeliveryText } from '../../lib/chatflow/markdown-delivery';

const labels: MarkdownLabels = {
  code: {
    copyLabel: '复制',
    copiedLabel: '已复制',
    toolbarLabels: {
      codeLabel: '代码',
      wrapLabel: '自动换行',
      unwrapLabel: '取消换行',
    },
  },
  footnotes: '注释',
};
const noArtifacts: readonly WorkbenchArtifact[] = [];

export const AssistantMarkdown = memo(function AssistantMarkdown({
  text,
  streaming = false,
  allowRemoteImages = true,
  artifacts = noArtifacts,
}: {
  text: string;
  streaming?: boolean;
  allowRemoteImages?: boolean;
  artifacts?: readonly WorkbenchArtifact[];
}) {
  const origin = typeof location === 'undefined' ? undefined : location.origin;
  const rendered = useMemo(
    () =>
      streaming && allowRemoteImages
        ? text
        : markdownDeliveryText(text, artifacts, allowRemoteImages, origin),
    [text, artifacts, allowRemoteImages, streaming, origin],
  );
  return <MarkdownText text={rendered} streaming={streaming} labels={labels} />;
});
