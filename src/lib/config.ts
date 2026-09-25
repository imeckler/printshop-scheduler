import fs from 'fs';
import toml from 'toml';
import { exitWithError } from './process';

export interface TwilioConfig {
  account_sid: string;
  auth_token: string;
  verify_service_sid: string;
  messaging_service_sid: string;
  phone_number: string;
}

export interface RisoConfig {
  adminUrl: string;
  pollingIntervalMinutes: number;
  copyPriceCents: number;
  stencilPriceCents: number;
}

// Discord OAuth app (no bot needed). Authorizers sign in with Discord; they
// are valid while they hold role_id in guild_id.
export interface DiscordConfig {
  client_id: string;
  client_secret: string;
  guild_id: string;
  role_id: string;
  poll_interval_minutes: number;
}

// Discord bot that announces new print requests (see lib/notify). The bot's
// code is the public printshop-discord-bot package. channel_id is the
// channel it posts in; /admin/notifier lists the channels the bot can see,
// so it can be left blank until you have it.
export interface DiscordBotConfig {
  bot_token: string;
  channel_id?: string;
}

export interface AppConfig {
  general: {
    domain: string;
    port: string;
    email: string;
    site_name: string;
    daemon_secret?: string;
    site_password?: string;
    // Password for the public print request form (/request). Unset = form disabled.
    request_password?: string;
  };
  database: {
    postgresql_url: string;
  };
  jwt: {
    secret: string;
  };
  twilio?: TwilioConfig;
  riso?: RisoConfig;
  discord?: DiscordConfig;
  discord_bot?: DiscordBotConfig;
}

const discordBotFromEnv = (): DiscordBotConfig | undefined => {
  if (!process.env.DISCORD_BOT_TOKEN) return undefined;
  return {
    bot_token: process.env.DISCORD_BOT_TOKEN,
    channel_id: process.env.DISCORD_REQUEST_CHANNEL_ID || undefined,
  };
};

const discordFromEnv = (required: (name: string) => string): DiscordConfig => ({
  client_id: required('DISCORD_CLIENT_ID'),
  client_secret: required('DISCORD_CLIENT_SECRET'),
  guild_id: required('DISCORD_GUILD_ID'),
  role_id: required('DISCORD_ROLE_ID'),
  poll_interval_minutes: parseInt(process.env.DISCORD_POLL_INTERVAL_MINUTES || '5', 10),
});

const configFromEnv = (): AppConfig => {
  const required = (name: string): string => {
    const val = process.env[name];
    if (!val) {
      exitWithError(`Missing required environment variable: ${name}`);
      return process.exit(1);
    }
    return val;
  };

  const config: AppConfig = {
    general: {
      domain: required('DOMAIN'),
      port: process.env.PORT || '8080',
      email: required('EMAIL'),
      site_name: process.env.SITE_NAME || 'Printshop Booking System',
      daemon_secret: process.env.DAEMON_SECRET,
      site_password: process.env.SITE_PASSWORD,
      request_password: process.env.REQUEST_PASSWORD,
    },
    database: {
      postgresql_url: required('DATABASE_URL'),
    },
    jwt: {
      secret: required('JWT_SECRET'),
    },
  };

  if (process.env.TWILIO_ACCOUNT_SID) {
    config.twilio = {
      account_sid: required('TWILIO_ACCOUNT_SID'),
      auth_token: required('TWILIO_AUTH_TOKEN'),
      verify_service_sid: required('TWILIO_VERIFY_SERVICE_SID'),
      messaging_service_sid: required('TWILIO_MESSAGING_SERVICE_SID'),
      phone_number: required('TWILIO_PHONE_NUMBER'),
    };
  }

  if (process.env.RISO_ADMIN_URL) {
    config.riso = {
      adminUrl: required('RISO_ADMIN_URL'),
      pollingIntervalMinutes: parseInt(process.env.RISO_POLLING_INTERVAL_MINUTES || '5', 10),
      copyPriceCents: parseInt(process.env.RISO_COPY_PRICE_CENTS || '10', 10),
      stencilPriceCents: parseInt(process.env.RISO_STENCIL_PRICE_CENTS || '100', 10),
    };
  }

  if (process.env.DISCORD_CLIENT_ID) {
    config.discord = discordFromEnv(required);
  }

  config.discord_bot = discordBotFromEnv();

  return config;
};

export const getConfig = (): AppConfig => {
  // If config.toml exists, use it (local dev). Otherwise, build config from env vars (production).
  try {
    fs.accessSync('./config/config.toml');
    const config = toml.parse(fs.readFileSync('./config/config.toml', 'utf-8')) as AppConfig;

    // Override database URL with environment variable if present
    if (process.env.DATABASE_URL) {
      config.database.postgresql_url = process.env.DATABASE_URL;
    }

    // Discord settings may also come from env when using config.toml
    if (process.env.DISCORD_CLIENT_ID) {
      config.discord = discordFromEnv(name => {
        const val = process.env[name];
        if (!val) {
          exitWithError(`Missing required environment variable: ${name}`);
          return process.exit(1);
        }
        return val;
      });
    }
    if (config.discord && !config.discord.poll_interval_minutes) {
      config.discord.poll_interval_minutes = 5;
    }
    if (config.discord_bot && !config.discord_bot.bot_token) {
      exitWithError('[discord_bot] needs bot_token (or set DISCORD_BOT_TOKEN)');
    }
    if (process.env.REQUEST_PASSWORD) {
      config.general.request_password = process.env.REQUEST_PASSWORD;
    }
    // Env vars overlay the [discord_bot] table rather than replacing it, so
    // e.g. DISCORD_BOT_TOKEN alone keeps a channel_id set in the file.
    const botEnv = discordBotFromEnv();
    if (botEnv) {
      config.discord_bot = {
        ...config.discord_bot,
        bot_token: botEnv.bot_token,
        ...(botEnv.channel_id ? { channel_id: botEnv.channel_id } : {}),
      };
    }

    return config;
  } catch {
    return configFromEnv();
  }
};
