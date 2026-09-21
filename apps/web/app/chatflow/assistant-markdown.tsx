import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { WorkbenchArtifact } from '@allrice/contracts';
import { artifactDownloadLink } from '../../lib/chatflow/artifact-download-link';

export function AssistantMarkdown({
  text,
  allowRemoteImages = true,
  artifacts = [],
}: {
  text: string;
  allowRemoteImages?: boolean;
  artifacts?: readonly WorkbenchArtifact[];
}) {
  return (
    <ReactMarkdown
      components={{
        ...(!allowRemoteImages
          ? {
              img: ({ alt }: { alt?: string }) => (
                <span>[图片：{alt || '未加载外部图片'}]</span>
              ),
            }
          : {}),
        a: ({ href, children, ...props }) => {
          const resolved = artifactDownloadLink(href, artifacts);
          const external = /^https?:\/\//i.test(resolved ?? '');
          return (
            <a
              {...props}
              href={resolved}
              {...(external
                ? { rel: 'noopener noreferrer', target: '_blank' }
                : {})}
            >
              {children}
            </a>
          );
        },
      }}
      remarkPlugins={[remarkGfm]}
    >
      {text}
    </ReactMarkdown>
  );
}
