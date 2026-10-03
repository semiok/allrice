import { memo, useCallback, useMemo } from 'react';
import {
  MarkdownDelegateProvider,
  MarkdownText,
  type MarkdownLabels,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { WorkbenchArtifact } from '@allrice/contracts';
import { markdownDeliveryText } from '../../lib/chatflow/markdown-delivery';
import { artifactForDownloadLink } from '../../lib/chatflow/artifact-download-link';

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
const noFiles: readonly { id: string; fileName: string }[] = [];

export const AssistantMarkdown = memo(function AssistantMarkdown({
  text,
  streaming = false,
  allowRemoteImages = true,
  artifacts = noArtifacts,
  accessibleFiles = noFiles,
  onOpenArtifact,
}: {
  text: string;
  streaming?: boolean;
  allowRemoteImages?: boolean;
  artifacts?: readonly WorkbenchArtifact[];
  accessibleFiles?: readonly { id: string; fileName: string }[];
  onOpenArtifact?: (id: string) => void;
}) {
  const origin = typeof location === 'undefined' ? undefined : location.origin;
  const rendered = useMemo(
    () =>
      streaming && allowRemoteImages
        ? text
        : markdownDeliveryText(
            text,
            artifacts,
            allowRemoteImages,
            origin,
            accessibleFiles,
          ),
    [text, artifacts, accessibleFiles, allowRemoteImages, streaming, origin],
  );
  const openLink = useCallback(
    (href: string) => {
      const artifact = artifactForDownloadLink(href, artifacts);
      if (artifact && onOpenArtifact) onOpenArtifact(artifact.id);
      else window.open(href, '_blank', 'noopener,noreferrer');
    },
    [artifacts, onOpenArtifact],
  );
  return (
    <MarkdownDelegateProvider
      openExternalLink={onOpenArtifact ? openLink : undefined}
    >
      <MarkdownText text={rendered} streaming={streaming} labels={labels} />
    </MarkdownDelegateProvider>
  );
});
