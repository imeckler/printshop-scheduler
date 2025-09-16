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

export const getConfig = (): AppConfig => {
  try {
    const config = toml.parse(fs.readFileSync('./config/config.toml', 'utf-8')) as AppConfig;
    return config;
  } catch {
    exitWithError(
      "Configuration file not found! Have you renamed './config/config-example.toml' to './config/config.toml'?"
    );
    return process.exit(1);
  }
};
