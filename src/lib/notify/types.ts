// A RequestNotifier announces new print requests in some group chat and
// reports back when a member "claims" one from the announcement (on
// Discord: a button under it).
//
// The rest of the app only talks to this interface (see printRequests.ts).
// The current implementation is Discord (./discord.ts, on top of the
// separately published printshop-discord-bot package); another channel
// would be another implementation picked in index.ts. The claimant's
// identity is a tagged union so each channel resolves its own kind of user
// id to a site account.

export type NotifierChannel = 'discord';

// Who claimed from an announcement, in the channel's own terms. Resolved to
// a site user by printRequests.resolveClaimant.
export type ClaimantIdentity = { kind: 'discord'; discordUserId: string; username: string };

// Where an announcement ended up: enough to match a later claim to it.
export interface AnnouncementRef {
  channel: NotifierChannel;
  ref: string; // the channel's message id (for Discord: "<channel id>/<message id>")
}

// An announcement together with the request it was for. Follow-ups name
// the request in their text, since depending on the bot's FOLLOW_UP_MODE
// they may be plain messages rather than replies to the announcement.
export interface PostedNotification extends AnnouncementRef {
  requestId: number;
}

export interface NewRequestSummary {
  requestId: number;
  name: string;
  printType: string;
  neededBy: string; // yyyy-mm-dd
  desiredSize: string | null;
  url: string; // absolute link to /requests/:id
}

export interface ClaimEvent {
  // Which announcement the claim came from. The handler only acts on refs
  // that were stored when announcing.
  posted: AnnouncementRef;
  claimant: ClaimantIdentity;
  // Answer the claimant so that only they see it (Discord: an ephemeral
  // reply to their click). Falls back to a public follow-up when absent.
  replyPrivately?: (text: string) => Promise<void>;
}

export type ClaimHandler = (event: ClaimEvent) => Promise<void>;

// Shown on /admin/notifier. `chats` lists the channels the bot can post to
// so an admin can find the id to configure; `inviteUrl` is the link a
// server admin uses to add the bot.
export interface NotifierStatus {
  channel: NotifierChannel | 'none';
  state: 'disabled' | 'starting' | 'ready' | 'disconnected' | 'error';
  detail?: string;
  botName?: string;
  inviteUrl?: string;
  targetChatId?: string;
  targetChatName?: string;
  chats?: Array<{ id: string; name: string }>;
}

export interface RequestNotifier {
  readonly channel: NotifierChannel | 'none';
  start(): Promise<void>;
  stop(): Promise<void>;
  // Returns null when nothing was posted (channel disabled, not connected,
  // no target channel configured). Never throws: a broken chat must not
  // block a request from being saved.
  postNewRequest(summary: NewRequestSummary): Promise<PostedNotification | null>;
  // Follow-ups on an announcement. Best effort, never throw.
  postClaimed(posted: PostedNotification, claimantName: string): Promise<void>;
  postClaimFailed(posted: PostedNotification, reason: string): Promise<void>;
  postCompleted(posted: PostedNotification, byName: string): Promise<void>;
  onClaim(handler: ClaimHandler): void;
  status(): Promise<NotifierStatus>;
}

// Used when no channel is configured: requests are still saved and visible
// on /requests, they just aren't announced anywhere.
export class NullNotifier implements RequestNotifier {
  readonly channel = 'none' as const;
  constructor(
    private readonly detail = 'No Discord bot configured. Set DISCORD_BOT_TOKEN (see config) to announce requests.'
  ) {}
  async start() {}
  async stop() {}
  async postNewRequest() {
    return null;
  }
  async postClaimed() {}
  async postClaimFailed() {}
  async postCompleted() {}
  onClaim() {}
  async status(): Promise<NotifierStatus> {
    return { channel: 'none', state: 'disabled', detail: this.detail };
  }
}
