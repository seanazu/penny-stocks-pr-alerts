import axios from "axios";
import { cfg } from "../config.js";

/**
 * Send a plain text message to a Discord channel using Bot Token + Channel ID.
 * Notes:
 * - Bot must be in the server and have "Send Messages" permission for the channel.
 * - Discord limits content to 2000 chars.
 */
export async function notifyDiscord(content: string): Promise<void> {
  const token = cfg.DISCORD_BOT_TOKEN;
  const channelId = cfg.DISCORD_CHANNEL_ID;
  if (!token || !channelId) return;

  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const headers = {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  };

  const body = { content: content.slice(0, 2000) };

  try {
    await axios.post(url, body, { headers, timeout: 7000 });
  } catch (err: any) {
    const status = err?.response?.status;
    // Simple 429 retry once, honoring retry_after if present
    if (status === 429) {
      const retryAfter = (err.response.data?.retry_after ?? 1) * 1000;
      await new Promise((r) => setTimeout(r, retryAfter));
      try {
        await axios.post(url, body, { headers, timeout: 7000 });
      } catch {
        /* swallow second failure */
      }
    }
    // swallow other errors — alerts shouldn't crash the runner
  }
}
