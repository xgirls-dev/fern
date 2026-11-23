import { useEffect, useRef, useState, type RefObject } from "react";
import type { TextMessage } from "../lib/textThreads";

function messageForOutcome(reply: TextMessage, inspection: boolean) {
  if (inspection) {
    if (reply.status === "complete") return "Image check complete.";
    if (reply.status === "stopped") return "Image check stopped.";
    if (reply.status === "failed") return "Image check failed. Details are in the reply.";
  }
  const partial = !!(reply.content.trim() || reply.reasoning || reply.generatedImage);
  if (reply.metrics?.finishReason === "length") {
    if (reply.status === "complete") return "Reply reached the output limit. Partial reply available.";
    if (reply.status === "failed") return "The model reached the output limit before finishing an answer.";
  }
  if (reply.status === "complete") return "Reply ready.";
  if (reply.status === "stopped") return partial ? "Response stopped. Partial reply available." : "Response stopped.";
  if (reply.status === "failed") return partial ? "Response incomplete. Partial reply available." : "Response failed. Details are in the reply.";
  return "";
}

export function TextReplyAnnouncement({ jobId, inspectionMessageId, messages, conversation }: {
  jobId: string | null;
  inspectionMessageId?: string;
  messages: TextMessage[];
  conversation: RefObject<HTMLDivElement | null>;
}) {
  const active = useRef<{ jobId: string; inspectionMessageId?: string } | undefined>(undefined);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const previous = active.current;
    if (jobId) {
      if (previous?.jobId !== jobId) setAnnouncement("");
      active.current = { jobId, inspectionMessageId };
      return;
    }
    if (!previous) return;
    const inspection = previous.inspectionMessageId;
    const reply = inspection ? messages.find((message) => message.id === inspection) : messages.find((message) => message.jobId === previous.jobId);
    if (!reply) { active.current = undefined; return; }
    const feed = conversation.current;
    const rowSelector = `[data-chat-message="${CSS.escape(reply.id)}"]`;
    const announce = () => {
      if (feed?.querySelector(`${rowSelector} .text-message-content [data-chat-markdown-formatting]`)) return false;
      active.current = undefined;
      setAnnouncement(messageForOutcome(reply, !!inspection));
      return true;
    };
    if (announce() || !feed) return;
    const observer = new MutationObserver(() => {
      if (announce()) observer.disconnect();
    });
    observer.observe(feed, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [conversation, inspectionMessageId, jobId, messages]);

  return <span className="sr-only" role="status" aria-label="Reply status" aria-atomic="true">{announcement}</span>;
}
