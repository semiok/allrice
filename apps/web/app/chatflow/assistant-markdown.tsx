import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function AssistantMarkdown({
  text,
  allowRemoteImages = true,
}: {
  text: string;
  allowRemoteImages?: boolean;
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
          const external = /^https?:\/\//i.test(href ?? '');
          return (
            <a
              {...props}
              href={href}
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
