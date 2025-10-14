import axios from "axios";
import { cfg } from "../config.js";

// ---------- Types ----------
type EmbedField = { name: string; value: string; inline?: boolean };
type Embed = {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string; // ISO
  fields?: EmbedField[];
  footer?: { text: string; icon_url?: string };
  author?: { name: string; url?: string; icon_url?: string };
  thumbnail?: { url: string };
  image?: { url: string };
};

type Button = {
  type: 2; // BUTTON
  style: 5 | 1 | 2 | 3 | 4; // 5 = LINK; 1-4 = primary/secondary/success/danger (require interactions)
  label: string;
  url?: string; // required for LINK buttons
  custom_id?: string; // for non-link buttons (not used here)
  emoji?: { name: string; id?: string };
  disabled?: boolean;
};

type ActionRow = { type: 1; components: Button[] };

type SendOptions =
  | string
  | {
      content?: string;
      embeds?: Embed[];
      components?: ActionRow[]; // buttons
      // auto-thread options
      thread?: { name: string; autoArchiveMinutes?: 60 | 1440 | 4320 | 10080 };
      // post-send reactions
      reactions?: string[]; // e.g., ["👀","📈","💬"]
      // message reference (reply)
      reply_to_message_id?: string;
      // suppress link previews in content, if any
      suppress_embeds?: boolean;
    };

// ---------- Limits ----------
const LIMITS = {
  CONTENT: 2000,
  TITLE: 256,
  DESC: 4096,
  FIELDS: 25,
  FIELD_NAME: 256,
  FIELD_VALUE: 1024,
  TOTAL_EMBEDS: 10,
};

function sanitizeEmbed(e: Embed): Embed {
  const out: Embed = { ...e };
  if (out.title && out.title.length > LIMITS.TITLE)
    out.title = out.title.slice(0, LIMITS.TITLE - 1) + "…";
  if (out.description && out.description.length > LIMITS.DESC)
    out.description = out.description.slice(0, LIMITS.DESC - 1) + "…";
  if (out.fields) {
    out.fields = out.fields.slice(0, LIMITS.FIELDS).map((f) => {
      let name = f.name || "";
      let value = f.value || "";
      if (name.length > LIMITS.FIELD_NAME)
        name = name.slice(0, LIMITS.FIELD_NAME - 1) + "…";
      if (value.length > LIMITS.FIELD_VALUE)
        value = value.slice(0, LIMITS.FIELD_VALUE - 1) + "…";
      return { name, value, inline: f.inline };
    });
  }
  return out;
}

function sanitizeComponents(rows?: ActionRow[]): ActionRow[] | undefined {
  if (!rows?.length) return undefined;
  // Discord allows up to 5 rows, each up to 5 buttons
  return rows.slice(0, 5).map((r) => ({
    type: 1,
    components: (r.components || []).slice(0, 5),
  }));
}

async function requestWith429Retry(url: string, body: any, headers: any) {
  try {
    return await axios.post(url, body, { headers, timeout: 8000 });
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 429) {
      const retryAfter = (err.response.data?.retry_after ?? 1) * 1000;
      await new Promise((r) => setTimeout(r, retryAfter));
      return await axios.post(url, body, { headers, timeout: 8000 });
    }
    throw err;
  }
}

/**
 * Send message via Bot Token + Channel ID.
 * - Plain text: notifyDiscord("hello")
 * - Rich: notifyDiscord({ content, embeds, components, thread, reactions })
 * Returns the created messageId (if any).
 */
export async function notifyDiscord(
  opts: SendOptions
): Promise<{ messageId?: string; threadId?: string } | void> {
  const token = cfg.DISCORD_BOT_TOKEN;
  const channelId = cfg.DISCORD_CHANNEL_ID;
  if (!token || !channelId) return;

  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const headers = {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  };

  // Build body
  let content: string | undefined;
  let embeds: Embed[] | undefined;
  let components: ActionRow[] | undefined;
  let reply_to_message_id: string | undefined;
  let suppress_embeds: boolean | undefined;
  let threadName: string | undefined;
  let threadAutoArchive: 60 | 1440 | 4320 | 10080 | undefined;
  let reactions: string[] | undefined;

  if (typeof opts === "string") {
    content = opts.slice(0, LIMITS.CONTENT);
  } else {
    content = opts.content ? opts.content.slice(0, LIMITS.CONTENT) : undefined;
    embeds = (opts.embeds || [])
      .slice(0, LIMITS.TOTAL_EMBEDS)
      .map(sanitizeEmbed);
    components = sanitizeComponents(opts.components);
    reply_to_message_id = opts.reply_to_message_id;
    suppress_embeds = opts.suppress_embeds;
    if (opts.thread) {
      threadName = opts.thread.name?.slice(0, 100);
      threadAutoArchive = (opts.thread.autoArchiveMinutes as any) ?? 1440;
    }
    reactions = opts.reactions;
  }

  const flags = suppress_embeds ? 1 << 2 /* SUPPRESS_EMBEDS */ : undefined;
  const body: any = {
    content,
    embeds,
    components,
    flags,
    message_reference: reply_to_message_id
      ? { message_id: reply_to_message_id, channel_id: channelId }
      : undefined,
  };

  let res;
  try {
    res = await requestWith429Retry(url, body, headers);
  } catch {
    return;
  }

  const messageId: string | undefined = res?.data?.id;

  // --- Optional: create a thread from this message
  let threadId: string | undefined;
  if (messageId && threadName) {
    const tUrl = `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/threads`;
    const tBody = {
      name: threadName,
      auto_archive_duration: threadAutoArchive ?? 1440,
    };
    try {
      const tRes = await requestWith429Retry(tUrl, tBody, headers);
      threadId = tRes?.data?.id;
    } catch {
      // ignore (not all channels allow threads)
    }
  }

  // --- Optional: add reactions
  if (messageId && reactions?.length) {
    for (const emoji of reactions.slice(0, 10)) {
      // emoji must be URL-encoded
      const e = encodeURIComponent(emoji);
      const rUrl = `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${e}/@me`;
      try {
        await axios.put(rUrl, null, { headers, timeout: 5000 });
      } catch {
        // ignore per-reaction failures
      }
    }
  }

  return { messageId, threadId };
}
