// WhatsApp implementation of RequestNotifier, on top of whatsapp-web.js
// (which drives a headless WhatsApp Web session in Chromium; there is no
// official API for personal accounts).
//
// Linking: on first start the library emits a QR code, shown on
// /admin/notifier; scan it from the phone that owns the account (WhatsApp >
// Linked devices). The session is kept under `dataPath` so restarts don't
// need a new scan; if that directory is lost (redeploy without a volume)
// the admin page shows a fresh QR.
//
// Claiming: a 👍 reaction to the announcement message is a claim. The
// reactor is identified by phone number, which is what site accounts are
// keyed on, so no separate account linking is needed.

import path from 'path';
import { Client, LocalAuth, Message, Reaction } from 'whatsapp-web.js';
import type { WhatsAppConfig } from '../config';
import {
  ClaimHandler,
  NewRequestSummary,
  NotifierStatus,
  PostedNotification,
  RequestNotifier,
} from './types';

const THUMBS_UP = '👍';

const isThumbsUp = (emoji: string): boolean => emoji.startsWith(THUMBS_UP); // incl. skin tones

// "15551234567@c.us" -> "+15551234567"
const jidToE164 = (jid: string): string | null => {
  const m = /^(\d{7,16})@c\.us$/.exec(jid);
  return m ? `+${m[1]}` : null;
};

export class WhatsAppNotifier implements RequestNotifier {
  readonly channel = 'whatsapp' as const;
  private client: Client;
  private state: NotifierStatus['state'] = 'starting';
  private detail: string | undefined;
  private qr: string | undefined;
  private claimHandlers: ClaimHandler[] = [];
  private starting: Promise<void> | null = null;

  constructor(private readonly config: WhatsAppConfig) {
    const executablePath = process.env.CHROMIUM_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: path.resolve(config.data_path || './.wwebjs_auth'),
      }),
      puppeteer: {
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        // Chromium refuses to run sandboxed as root / in most containers.
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    });
    this.wire();
  }

  private wire() {
    const c = this.client;
    c.on('qr', qr => {
      this.state = 'needs_link';
      this.qr = qr;
      this.detail = 'Scan the QR code with the WhatsApp account that should post announcements.';
      console.log('whatsapp: waiting for QR scan (see /admin/notifier)');
    });
    c.on('authenticated', () => {
      this.qr = undefined;
      this.state = 'starting';
      this.detail = 'Linked; loading chats…';
    });
    c.on('auth_failure', msg => {
      this.state = 'error';
      this.detail = `Authentication failed: ${msg}`;
      console.error('whatsapp: auth failure', msg);
    });
    c.on('ready', () => {
      this.state = 'ready';
      this.detail = undefined;
      console.log('whatsapp: ready');
    });
    c.on('disconnected', reason => {
      this.state = 'disconnected';
      this.detail = `Disconnected: ${reason}`;
      console.warn('whatsapp: disconnected', reason);
      // The library tears the browser down on disconnect (without awaiting
      // it); give that a moment, make sure it's really closed, then start
      // over so a new QR (or the stored session) gets picked up.
      setTimeout(() => {
        this.starting = null;
        this.stop()
          .then(() => this.start())
          .catch(err => {
            this.state = 'error';
            this.detail = `Failed to reconnect: ${(err as Error).message}`;
          });
      }, 5000);
    });
    c.on('message_reaction', reaction => {
      this.handleReaction(reaction).catch(err =>
        console.error('whatsapp: reaction handler failed', err)
      );
    });
  }

  private async handleReaction(reaction: Reaction) {
    if (!isThumbsUp(reaction.reaction || '')) return; // '' = reaction removed
    const ref = reaction.msgId?._serialized;
    if (!ref) return;
    if (this.claimHandlers.length === 0) return;

    // In groups the sender may be reported as a "lid" (linked id) rather
    // than a phone jid; ask the library for the phone number either way.
    let phoneJid: string | undefined;
    try {
      const [info] = await this.client.getContactLidAndPhone([reaction.senderId]);
      phoneJid = info?.pn;
    } catch (err) {
      console.warn('whatsapp: could not resolve reactor phone', reaction.senderId, err);
    }
    const phoneE164 = jidToE164(phoneJid || reaction.senderId);
    if (!phoneE164) {
      console.warn('whatsapp: reactor has no phone jid', reaction.senderId);
      return;
    }
    const event = {
      posted: { channel: this.channel, ref },
      claimant: { kind: 'whatsapp' as const, phoneE164 },
    };
    for (const h of this.claimHandlers) await h(event);
  }

  async start() {
    if (!this.starting) {
      this.starting = this.client.initialize().catch(err => {
        this.state = 'error';
        this.detail = `Failed to start: ${(err as Error).message}`;
        console.error('whatsapp: initialize failed', err);
      });
    }
    // Don't block server startup on the browser coming up.
    void this.starting;
  }

  async stop() {
    try {
      await this.client.destroy();
    } catch {
      /* already down */
    }
  }

  onClaim(handler: ClaimHandler) {
    this.claimHandlers.push(handler);
  }

  private async send(chatId: string, text: string, quoted?: string): Promise<Message | null> {
    if (this.state !== 'ready') {
      console.warn(`whatsapp: not ready (${this.state}); dropping message`);
      return null;
    }
    try {
      return await this.client.sendMessage(chatId, text, quoted ? { quotedMessageId: quoted } : {});
    } catch (err) {
      console.error('whatsapp: sendMessage failed', err);
      return null;
    }
  }

  async postNewRequest(s: NewRequestSummary): Promise<PostedNotification | null> {
    const chatId = this.config.group_id;
    if (!chatId) {
      console.warn('whatsapp: no group_id configured; request not announced');
      return null;
    }
    const lines = [
      `🖨️ New print request #${s.requestId} from ${s.name}`,
      `Type: ${s.printType}`,
      `Needed by: ${s.neededBy}`,
      ...(s.desiredSize ? [`Size: ${s.desiredSize}`] : []),
      s.url,
      '',
      `React ${THUMBS_UP} to this message to claim it.`,
    ];
    const msg = await this.send(chatId, lines.join('\n'));
    return msg ? { channel: this.channel, ref: msg.id._serialized } : null;
  }

  private chatIdOf(posted: PostedNotification): string | null {
    // Message ids look like "true_<chat id>_<hash>"; the chat is the middle part.
    const m = /^(?:true|false)_([^_]+)_/.exec(posted.ref);
    return m ? m[1] : this.config.group_id || null;
  }

  private async reply(posted: PostedNotification, text: string) {
    if (posted.channel !== this.channel) return;
    const chatId = this.chatIdOf(posted);
    if (chatId) await this.send(chatId, text, posted.ref);
  }

  async postClaimed(posted: PostedNotification, claimantName: string) {
    await this.reply(posted, `✅ Claimed by ${claimantName}.`);
  }

  async postClaimFailed(posted: PostedNotification, reason: string) {
    await this.reply(posted, `⚠️ ${reason}`);
  }

  async postCompleted(posted: PostedNotification, byName: string) {
    await this.reply(posted, `🎉 Completed by ${byName}. The requester has been texted.`);
  }

  async status(): Promise<NotifierStatus> {
    const status: NotifierStatus = {
      channel: this.channel,
      state: this.state,
      detail: this.detail,
      qr: this.qr,
      targetChatId: this.config.group_id,
    };
    if (this.state === 'ready') {
      try {
        const chats = await this.client.getChats();
        status.chats = chats
          .filter(c => c.isGroup)
          .map(c => ({ id: c.id._serialized, name: c.name }));
        status.targetChatName = status.chats.find(c => c.id === this.config.group_id)?.name;
      } catch (err) {
        status.detail = `Could not list chats: ${(err as Error).message}`;
      }
    }
    return status;
  }

  async unlink() {
    try {
      await this.client.logout();
    } catch (err) {
      console.warn('whatsapp: logout failed', err);
    }
    this.state = 'starting';
    this.qr = undefined;
    this.detail = 'Unlinked; waiting for a new QR code…';
    this.starting = null;
    await this.start();
  }
}
