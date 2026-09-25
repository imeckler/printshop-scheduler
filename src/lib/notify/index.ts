import { AppConfig } from '../config';
import { NullNotifier, RequestNotifier } from './types';
import { DiscordNotifier } from './discord';

export * from './types';

// Picks the announcement channel from config. Another channel would be
// another RequestNotifier implementation returned here.
export function createRequestNotifier(config: AppConfig): RequestNotifier {
  if (!config.discord_bot) return new NullNotifier();
  // Claims from Discord are matched to accounts linked via the OAuth app
  // ([discord]); without it the bot would announce requests that nobody
  // can claim from the channel, and send people to a dead /discord/link.
  if (!config.discord) {
    console.error('discord_bot is configured but [discord] (the OAuth app) is not; not announcing');
    return new NullNotifier(
      'Discord bot configured, but the [discord] OAuth app (DISCORD_CLIENT_ID etc.) is missing, so members could not link their accounts. Not announcing.'
    );
  }
  return new DiscordNotifier(config.discord_bot, config.discord.client_id);
}
