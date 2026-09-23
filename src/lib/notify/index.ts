import { AppConfig } from '../config';
import { NullNotifier, RequestNotifier } from './types';
import { WhatsAppNotifier } from './whatsapp';

export * from './types';

// Picks the announcement channel from config. To add Discord: implement
// RequestNotifier in ./discord.ts and return it here when config.discord
// has a bot token + channel id.
export function createRequestNotifier(config: AppConfig): RequestNotifier {
  if (config.whatsapp) return new WhatsAppNotifier(config.whatsapp);
  return new NullNotifier();
}
