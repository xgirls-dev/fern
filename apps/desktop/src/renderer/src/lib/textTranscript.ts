import { findChatImage, type TextMessage, type TextReplyPreview, type TextThread } from "./textThreads";

export type TranscriptDestination = "clipboard" | "file";

function plainLabel(value: string) {
  return value.replace(/\s+/g, " ").trim().replace(/[\\`*_{}\[\]()<>#+!|~&]/g, "\\$&");
}

function transcriptTurn(author: string, paragraphs: string[]) {
  if (!paragraphs.length) return;
  // Each turn is its own block so an interrupted Markdown fence ends with that turn.
  const quoted = paragraphs.join("\n\n").replace(/\r\n?/g, "\n").split("\n")
    .map((line) => line ? `> ${line}` : ">").join("\n");
  return `## ${plainLabel(author)}\n\n${quoted}`;
}

function imageDescription(image: TextMessage["generatedImage"]) {
  return image ? `**Generated image** · ${plainLabel(image.prompt || image.name)}` : undefined;
}

function imageDescriptions(reply?: TextReplyPreview) {
  return reply?.generatedImages?.length ? reply.generatedImages.map(imageDescription) : [imageDescription(reply?.generatedImage)];
}

export function formatTextTranscript(thread: TextThread, preview?: TextReplyPreview, pendingModelName?: string) {
  const sections = [`# ${plainLabel(thread.title) || "Fern chat"}`];
  for (const message of thread.messages) {
    const author = message.role === "user" ? "You" : message.modelName || message.metrics?.modelName || "Assistant";
    const status = message.status === "stopped" ? "Response stopped."
      : message.status === "failed" ? "Response incomplete."
      : message.metrics?.finishReason === "length" ? "Reached the output limit." : undefined;
    const included = message.includedImage && (findChatImage(thread, message.includedImage)?.prompt || message.includedImage);
    const turn = transcriptTurn(author, [
      status && `*${status}*`,
      message.image && `**Image attachment** · ${plainLabel(message.image)}`,
      included && `**Image included** · ${plainLabel(included)}`,
      ...imageDescriptions(message),
      message.content.trim() && message.content,
    ].filter((line): line is string => !!line));
    if (turn) sections.push(turn);
  }
  if (thread.pendingJobId && !thread.messages.some((message) => message.inspectionJobId === thread.pendingJobId)) {
    const turn = transcriptTurn(pendingModelName || "Assistant", [
      "*Response in progress when exported.*",
      ...imageDescriptions(preview),
      preview?.content.trim() && preview.content,
    ].filter((line): line is string => !!line));
    if (turn) sections.push(turn);
  }
  return sections.join("\n\n") + "\n";
}
