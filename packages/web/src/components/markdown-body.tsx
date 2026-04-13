"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function joinClasses(...classes: Array<string | undefined | false>): string {
  return classes.filter(Boolean).join(" ");
}

export default function MarkdownBody({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={joinClasses("formatted-markdown", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ className: linkClassName, ...props }) => (
            <a
              {...props}
              className={joinClasses(
                "text-[var(--accent)] underline underline-offset-4 hover:brightness-110 transition-colors",
                linkClassName,
              )}
              target="_blank"
              rel="noreferrer"
            />
          ),
          code: ({ className: codeClassName, children, ...props }) => {
            const isInline = !codeClassName?.includes("language-");

            if (isInline) {
              return (
                <code
                  {...props}
                  className={joinClasses(
                    "rounded bg-white/8 px-1.5 py-0.5 font-mono text-[0.92em] text-foreground/95",
                    codeClassName,
                  )}
                >
                  {children}
                </code>
              );
            }

            return (
              <code
                {...props}
                className={joinClasses("block font-mono text-sm text-[#d4d4d4]", codeClassName)}
              >
                {children}
              </code>
            );
          },
          pre: ({ className: preClassName, children, ...props }) => (
            <pre
              {...props}
              className={joinClasses(
                "overflow-x-auto rounded-lg border border-white/8 bg-[#0b0b0f] p-3",
                preClassName,
              )}
            >
              {children}
            </pre>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
