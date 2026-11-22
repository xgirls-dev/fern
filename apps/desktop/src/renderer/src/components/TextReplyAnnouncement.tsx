import { useEffect, useRef, useState } from "react";
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

export function TextReplyAnnouncement({ jobId, inspectionMessageId, messages }: {
  jobId: string | null;
  inspectionMessageId?: string;
  messages: TextMessage[];
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
    active.current = undefined;
    const inspection = previous.inspectionMessageId;
    const reply = inspection ? messages.find((message) => message.id === inspection) : messages.find((message) => message.jobId === previous.jobId);
    if (reply) setAnnouncement(messageForOutcome(reply, !!inspection));
  }, [inspectionMessageId, jobId, messages]);

  return <span className="sr-only" role="status" aria-label="Reply status" aria-atomic="true">{announcement}</span>;
}
