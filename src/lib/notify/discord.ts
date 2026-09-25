// Discord implementation of RequestNotifier.
//
// The Discord mechanics (gateway connection, posting, the claim button)
// live in the printshop-discord-bot package, which is a separate public
// repository so the server's admins can review exactly what the bot does
// before adding it. This file only decides what to say and turns the bot's
// claim events into ClaimEvents.
//
// Claiming: clicking the "Claim" button under the announcement is a claim.
// The clicker is identified by Discord user id, which print squad members
// link to their site account at /discord/link (see
// printRequests.resolveClaimant).

import { PrintRequestBot, escapeUserText, inviteUrl } from 'printshop-discord-bot';
import type { DiscordBotConfig } from '../config';
import {
  ClaimHandler,
  NewRequestSummary,
  NotifierStatus,
  PostedNotification,
  RequestNotifier,
} from './types';

export class DiscordNotifier implements RequestNotifier {
  readonly channel = 'discord' as const;
  private readonly bot: PrintRequestBot;
  private readonly claimHandlers: ClaimHandler[] = [];

  // `clientId` (the OAuth application's id) is only used to build the
  // invite link shown on the admin page.
  constructor(
    private readonly config: DiscordBotConfig,
    private readonly clientId?: string
  ) {
    this.bot = new PrintRequestBot({
      token: config.bot_token,
      channelId: config.channel_id,
    });
    this.bot.onClaim(async claim => {
      const event = {
        posted: { channel: this.channel, ref: claim.ref },
        claimant: {
          kind: 'discord' as const,
          discordUserId: claim.userId,
          username: claim.username,
        },
        replyPrivately: claim.replyPrivately,
      };
      for (const h of this.claimHandlers) await h(event);
    });
  }

  async start() {
    // Don't block server startup on Discord; a bad token shows up on
    // /admin/notifier and in the logs.
    this.bot.start().catch(err => console.error('discord: login failed', err));
  }

  async stop() {
    await this.bot.stop();
  }

  onClaim(handler: ClaimHandler) {
    this.claimHandlers.push(handler);
  }

  async postNewRequest(s: NewRequestSummary): Promise<PostedNotification | null> {
    // Name, type and size come from the public form: escape them so they
    // can't inject markdown (masked links in particular) into the channel.
    const lines = [
      `🖨️ **New print request #${s.requestId}** from ${escapeUserText(s.name)}`,
      `Type: ${escapeUserText(s.printType)}`,
      `Needed by: ${s.neededBy}`,
      ...(s.desiredSize ? [`Size: ${escapeUserText(s.desiredSize)}`] : []),
      `<${s.url}>`, // angle brackets: no link preview (the page needs a login anyway)
      '',
      'Click **Claim** below to take it.',
    ];
    const ref = await this.bot.announce(lines.join('\n'));
    return ref ? { channel: this.channel, ref, requestId: s.requestId } : null;
  }

  private async reply(posted: PostedNotification, text: string) {
    if (posted.channel !== this.channel) return;
    await this.bot.reply(posted.ref, text);
  }

  async postClaimed(posted: PostedNotification, claimantName: string) {
    await this.reply(
      posted,
      `✅ Request #${posted.requestId} claimed by ${escapeUserText(claimantName)}.`
    );
  }

  async postClaimFailed(posted: PostedNotification, reason: string) {
    await this.reply(posted, `⚠️ Request #${posted.requestId}: ${reason}`);
  }

  async postCompleted(posted: PostedNotification, byName: string) {
    await this.reply(
      posted,
      `🎉 Request #${posted.requestId} completed by ${escapeUserText(byName)}. The requester has been texted.`
    );
  }

  async status(): Promise<NotifierStatus> {
    const s = await this.bot.status();
    return {
      channel: this.channel,
      state: s.state === 'stopped' ? 'disabled' : s.state,
      detail: s.detail,
      botName: s.botUser?.tag,
      inviteUrl: this.clientId ? inviteUrl(this.clientId) : undefined,
      targetChatId: this.config.channel_id,
      targetChatName: s.channel?.name,
      chats: s.state === 'ready' ? s.channels : undefined,
    };
  }
}
