import "dotenv/config";
import { z } from "zod";

/** Validate & normalize environment variables */
const EnvSchema = z.object({
  NEWS_LOOKBACK_MINUTES: z.coerce.number().optional(),
  MARKETAUX_API_KEY: z.string().optional(),
  FMP_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  POLYGON_API_KEY: z.string().optional(),
  BENZINGA_API_KEY: z.string().optional(),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_CHANNEL_ID: z.string().optional(),
  DB_PATH: z.string().default("./data/events.db"),
  POLL_NEWS_SECONDS: z.coerce.number().default(15),
  ALERT_THRESHOLD: z.coerce.number().default(0.72),
  VOL_Z_MIN: z.coerce.number().default(3),
  RET_1M_MIN: z.coerce.number().default(0.05),
  VWAP_DEV_MIN: z.coerce.number().default(0.02),
});

const env = EnvSchema.parse(process.env);

export const cfg = {
  ...env,
};
