// A RequestNotifier announces new print requests in some group chat and
// reports back when a member "claims" one by reacting to the announcement.
//
// The rest of the app only talks to this interface (see printRequests.ts),
// so swapping WhatsApp for Discord means writing another implementation of
// it (see whatsapp.ts for the shape) and picking it in index.ts. Nothing
// else needs to change; the claimant's identity is a tagged union so each
// channel resolves its own kind of user id to a site account.

export type NotifierChannel = 'whatsapp' | 'discord';

// Who reacted to an announcement, in the channel's own terms. Resolved to a
// site user by printRequests.resolveClaimant.
export type ClaimantIdentity =
  | { kind: 'whatsapp'; phoneE164: string }
  | { kind: 'discord'; discordUserId: string };

// Where an announcement ended up: enough to match a later reaction to it.
export interface PostedNotification {
  channel: NotifierChannel;
  ref: string; // the channel's message id
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
  posted: PostedNotification;
  claimant: ClaimantIdentity;
}

export type ClaimHandler = (event: ClaimEvent) => Promise<void>;

// Shown on /admin/notifier. `qr` is set while the channel is waiting to be
// linked (WhatsApp); `chats` lists the groups the account can post to so an
// admin can find the id to configure.
export interface NotifierStatus {
  channel: NotifierChannel | 'none';
  state: 'disabled' | 'starting' | 'needs_link' | 'ready' | 'disconnected' | 'error';
  detail?: string;
  qr?: string;
  targetChatId?: string;
  targetChatName?: string;
  chats?: Array<{ id: string; name: string }>;
}

export interface RequestNotifier {
  readonly channel: NotifierChannel | 'none';
  start(): Promise<void>;
  stop(): Promise<void>;
  // Returns null when nothing was posted (channel disabled, not linked, no
  // target chat configured). Never throws: a broken chat must not block a
  // request from being saved.
  postNewRequest(summary: NewRequestSummary): Promise<PostedNotification | null>;
  // Follow-ups on an announcement. Best effort, never throw.
  postClaimed(posted: PostedNotification, claimantName: string): Promise<void>;
  postClaimFailed(posted: PostedNotification, reason: string): Promise<void>;
  postCompleted(posted: PostedNotification, byName: string): Promise<void>;
  onClaim(handler: ClaimHandler): void;
  status(): Promise<NotifierStatus>;
  // Forget the linked account so it can be re-linked (WhatsApp QR). No-op elsewhere.
  unlink(): Promise<void>;
}

// Used when no channel is configured: requests are still saved and visible
// on /requests, they just aren't announced anywhere.
export class NullNotifier implements RequestNotifier {
  readonly channel = 'none' as const;
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
    return {
      channel: 'none',
      state: 'disabled',
      detail:
        'No group chat configured. Set WHATSAPP_ENABLED=true (see config) to announce requests.',
    };
  }
  async unlink() {}
}
