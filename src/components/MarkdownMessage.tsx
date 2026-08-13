import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const PROSE_CLASSES = [
  "prose prose-sm max-w-none break-words",
  "prose-headings:font-semibold prose-headings:text-ink",
  "prose-p:text-ink prose-li:text-ink prose-strong:text-ink prose-em:text-ink",
  "prose-a:text-brand prose-a:no-underline hover:prose-a:underline",
  "prose-blockquote:border-l-brand prose-blockquote:text-ink-muted",
  "prose-code:font-mono prose-code:text-brand prose-code:before:content-none prose-code:after:content-none",
  "prose-pre:rounded-md prose-pre:border prose-pre:border-border prose-pre:bg-surface prose-pre:text-ink",
  "prose-hr:border-border",
  "prose-th:text-ink prose-th:border-border prose-td:border-border",
].join(" ");

export function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className={PROSE_CLASSES}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
