import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function AssistantMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
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
