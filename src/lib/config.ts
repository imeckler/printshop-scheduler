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

export interface AppConfig {
  general: {
    domain: string;
    port: string;
    email: string;
    site_name: string;
    daemon_secret?: string;
    site_password?: string;
  };
  database: {
    postgresql_url: string;
  };
  jwt: {
    secret: string;
  };
  twilio?: TwilioConfig;
  riso?: RisoConfig;
}

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
    console.log('config from env twilio', config.twilio);
  }

  if (process.env.RISO_ADMIN_URL) {
    config.riso = {
      adminUrl: required('RISO_ADMIN_URL'),
      pollingIntervalMinutes: parseInt(process.env.RISO_POLLING_INTERVAL_MINUTES || '5', 10),
      copyPriceCents: parseInt(process.env.RISO_COPY_PRICE_CENTS || '10', 10),
      stencilPriceCents: parseInt(process.env.RISO_STENCIL_PRICE_CENTS || '100', 10),
    };
  }

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

    return config;
  } catch {
    console.log('config from env');
    return configFromEnv();
  }
};
