import { commitChatDatabase, type ChatDatabaseWrite } from "./textThreadDatabase";

self.onmessage = async ({ data }: MessageEvent<ChatDatabaseWrite>) => {
  try {
    await commitChatDatabase(data);
    self.postMessage({});
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "Chat storage was interrupted." });
  }
};
