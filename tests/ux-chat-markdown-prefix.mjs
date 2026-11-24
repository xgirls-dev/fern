import assert from "node:assert/strict";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true },
});

try {
  const { parseChatMarkdown, parseStreamingChatMarkdown } = await server.ssrLoadModule(
    "/apps/desktop/src/renderer/src/lib/chatMarkdown.ts",
  );
  const introduction = "**Opening** notes.\n\nA second paragraph.\n\nA third paragraph.";
  const previous = parseStreamingChatMarkdown(introduction);
  const appended = parseStreamingChatMarkdown(introduction + " More detail.", previous);
  assert.equal(appended.nodes[0], previous.nodes[0], "An unchanged formatted block keeps its identity");
  const rewritten = "**Opening** notes.\n\nA replacement paragraph.";
  assert.deepEqual(parseStreamingChatMarkdown(rewritten, appended).nodes, parseChatMarkdown(rewritten, true).children);

  const fence = String.fromCharCode(96).repeat(3);
  const replies = [
    "[Earlier link][report].\n\nAnother **note**.\n\nMore.\n\n[report]: https://example.test/report",
    "A footnote[^note].\n\nSecond **paragraph**.\n\nThird.\n\n[^note]: The definition arrived later.",
    introduction + "\n\n| Day | Count |\n| --- | --- |\n| Tue | 3 |\n\nAnother paragraph.",
    introduction + "\n\n" + fence + "js\nconst n = 2;\n" + fence + "\n\nEnd.",
    introduction + "\n\n- First item\n- Second item\n\n    Continued detail.\n\n> Last note",
    introduction.replaceAll("\n", "\r\n") + "\r\n\r\n### A heading\r\n\r\nAnother **line**.",
  ];
  for (const reply of replies) {
    let last;
    for (let end = 1; end <= reply.length; end++) {
      const content = reply.slice(0, end);
      last = parseStreamingChatMarkdown(content, last);
      assert.deepEqual(last.nodes, parseChatMarkdown(content, true).children, JSON.stringify(content));
    }
  }
  console.log("Streaming Markdown reuses unchanged blocks and matches a fresh parse through revisions and late definitions.");
} finally {
  await server.close();
}
