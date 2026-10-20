import { memo, useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import { notify } from "../lib/notifications";

function CodeBlock({ children }: ComponentPropsWithoutRef<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return <div className="text-code-block"><div className="text-code-toolbar"><span>Code</span><button type="button" onClick={async () => {
    try {
      await window.studio.copyText(ref.current?.textContent ?? "");
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch { setCopied(false); notify("Could not copy the code. Select it and copy manually.", "error"); }
  }} aria-label={copied ? "Code copied" : "Copy code"}><Copy size={13} aria-hidden="true" />{copied ? "Copied" : "Copy"}</button></div><pre ref={ref}>{children}</pre></div>;
}

const components = {
  pre: CodeBlock,
  // Model output cannot load remote images or invoke local URL schemes.
  img: ({ alt }: ComponentPropsWithoutRef<"img">) => <span>{alt}</span>,
  a: ({ href, children }: ComponentPropsWithoutRef<"a">) => /^https?:\/\//i.test(href ?? "")
    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
};
const plugins = [remarkGfm];
export const TextMarkdown = memo(function TextMarkdown({ content }: { content: string }) {
  return <Markdown remarkPlugins={plugins} components={components}>{content}</Markdown>;
});
