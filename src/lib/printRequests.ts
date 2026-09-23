// Print requests: the public /request form, the print squad's /requests
// pages, and the claim/complete flow shared by the site and the notifier.

import { and, desc, eq } from 'drizzle-orm';
import { db } from './db';
import { printRequestFiles, printRequests, users } from './schema';
import { User } from './dbtypes';
import twilioService from './twilio';
import { ClaimEvent, ClaimantIdentity, PostedNotification, RequestNotifier } from './notify';

export const PRINT_TYPES = ['poster', 'flyer', 'zine', 'other'] as const;
export type PrintType = (typeof PRINT_TYPES)[number];
export const PRINT_TYPE_LABELS: Record<PrintType, string> = {
  poster: 'Poster',
  flyer: 'Flyer',
  zine: 'Pamphlet / zine',
  other: 'Other',
};

export type PrintRequest = typeof printRequests.$inferSelect;
export type PrintRequestFileMeta = Omit<typeof printRequestFiles.$inferSelect, 'data'>;

// Loose input from the public form -> E.164, or null if it isn't a phone number.
// Bare 10-digit numbers are assumed to be US/Canada.
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 8 && digits.length <= 16 && !/^0/.test(digits)) return `+${digits}`;
  return null;
}

export const printTypeLabel = (r: { printType: string; printTypeOther: string | null }) =>
  r.printType === 'other'
    ? `Other: ${r.printTypeOther || '(not specified)'}`
    : (PRINT_TYPE_LABELS[r.printType as PrintType] ?? r.printType);

export interface NewPrintRequestInput {
  name: string;
  email: string;
  phoneE164: string;
  neededBy: string;
  printType: PrintType;
  printTypeOther: string | null;
  desiredSize: string | null;
  strictSize: boolean;
  notes: string | null;
  file: { filename: string; contentType: string; data: Buffer };
}

// Saves the request and its file in one transaction, then announces it.
// The announcement is best-effort: a chat outage must not lose a request.
export async function createPrintRequest(
  input: NewPrintRequestInput,
  notifier: RequestNotifier,
  baseUrl: string
): Promise<PrintRequest> {
  const { file, ...fields } = input;
  const request = await db.transaction(async tx => {
    const [row] = await tx.insert(printRequests).values(fields).returning();
    await tx.insert(printRequestFiles).values({
      requestId: row.requestId,
      filename: file.filename,
      contentType: file.contentType,
      sizeBytes: file.data.length,
      data: file.data,
    });
    return row;
  });

  const posted = await notifier.postNewRequest({
    requestId: request.requestId,
    name: request.name,
    printType: printTypeLabel(request),
    neededBy: request.neededBy,
    desiredSize: request.desiredSize,
    url: `${baseUrl}/requests/${request.requestId}`,
  });
  if (posted) {
    await db
      .update(printRequests)
      .set({ notificationChannel: posted.channel, notificationRef: posted.ref })
      .where(eq(printRequests.requestId, request.requestId));
    request.notificationChannel = posted.channel;
    request.notificationRef = posted.ref;
  }
  return request;
}

export async function listPrintRequests() {
  return db.query.printRequests.findMany({
    orderBy: desc(printRequests.createdAt),
    with: { claimedBy: { columns: { userId: true, name: true } } },
  });
}

export async function getPrintRequest(requestId: number) {
  return db.query.printRequests.findFirst({
    where: eq(printRequests.requestId, requestId),
    with: {
      claimedBy: { columns: { userId: true, name: true, phoneE164: true } },
      files: {
        columns: { fileId: true, filename: true, contentType: true, sizeBytes: true },
      },
    },
  });
}

export async function getPrintRequestFile(requestId: number, fileId: number) {
  return db.query.printRequestFiles.findFirst({
    where: and(eq(printRequestFiles.fileId, fileId), eq(printRequestFiles.requestId, requestId)),
  });
}

const displayName = (u: { name: string | null; phoneE164: string }) => u.name || u.phoneE164;

const postedOf = (r: PrintRequest): PostedNotification | null =>
  r.notificationChannel && r.notificationRef
    ? { channel: r.notificationChannel as PostedNotification['channel'], ref: r.notificationRef }
    : null;

export type ClaimResult =
  | { ok: true; request: PrintRequest }
  | { ok: false; reason: 'not_found' | 'already_claimed' | 'completed'; request?: PrintRequest };

// Atomically claims an open request. Racing claims: only the first UPDATE
// matches status = 'open'; the loser sees `already_claimed`.
export async function claimPrintRequest(requestId: number, user: User): Promise<ClaimResult> {
  const [updated] = await db
    .update(printRequests)
    .set({ status: 'claimed', claimedByUserId: user.userId, claimedAt: new Date() })
    .where(and(eq(printRequests.requestId, requestId), eq(printRequests.status, 'open')))
    .returning();
  if (updated) return { ok: true, request: updated };

  const current = await db.query.printRequests.findFirst({
    where: eq(printRequests.requestId, requestId),
  });
  if (!current) return { ok: false, reason: 'not_found' };
  if (current.status === 'completed') return { ok: false, reason: 'completed', request: current };
  if (current.claimedByUserId === user.userId) return { ok: true, request: current };
  return { ok: false, reason: 'already_claimed', request: current };
}

export async function unclaimPrintRequest(requestId: number, user: User): Promise<boolean> {
  const [updated] = await db
    .update(printRequests)
    .set({ status: 'open', claimedByUserId: null, claimedAt: null })
    .where(
      and(
        eq(printRequests.requestId, requestId),
        eq(printRequests.status, 'claimed'),
        eq(printRequests.claimedByUserId, user.userId)
      )
    )
    .returning();
  return !!updated;
}

// Marks the request done and texts the requester the pickup details.
export async function completePrintRequest(
  requestId: number,
  user: User,
  pickupDetails: string,
  notifier: RequestNotifier
): Promise<{ ok: true; request: PrintRequest; smsSent: boolean } | { ok: false; reason: string }> {
  const [updated] = await db
    .update(printRequests)
    .set({
      status: 'completed',
      completedAt: new Date(),
      pickupDetails,
      // Whoever completes it owns it, even if they never clicked "claim".
      claimedByUserId: user.userId,
    })
    .where(and(eq(printRequests.requestId, requestId), eq(printRequests.status, 'claimed')))
    .returning();
  if (!updated) {
    const current = await db.query.printRequests.findFirst({
      where: eq(printRequests.requestId, requestId),
    });
    if (!current) return { ok: false, reason: 'Request not found' };
    if (current.status === 'completed') return { ok: false, reason: 'Already completed' };
    return { ok: false, reason: 'Claim the request before completing it' };
  }

  const smsSent = await twilioService.sendSms(
    updated.phoneE164,
    `Hi ${updated.name}, your print job (#${updated.requestId}) is done! Pickup details: ${pickupDetails}`
  );
  const posted = postedOf(updated);
  if (posted) await notifier.postCompleted(posted, displayName(user));
  return { ok: true, request: updated, smsSent };
}

// Maps a channel identity to a site account. Each notifier channel keys on
// something different; WhatsApp gives us a phone number, which is what
// accounts are keyed on already. A Discord notifier would need a
// users.discord_user_id column (plus a way for members to link it) here.
export async function resolveClaimant(identity: ClaimantIdentity): Promise<User | null> {
  switch (identity.kind) {
    case 'whatsapp': {
      const user = await db.query.users.findFirst({
        where: eq(users.phoneE164, identity.phoneE164),
      });
      return user ?? null;
    }
    case 'discord':
      return null;
  }
}

// Wires the notifier's claim events (a 👍 on the announcement) into the DB.
export function handleNotifierClaims(notifier: RequestNotifier) {
  notifier.onClaim(async ({ posted, claimant }: ClaimEvent) => {
    const request = await db.query.printRequests.findFirst({
      where: and(
        eq(printRequests.notificationChannel, posted.channel),
        eq(printRequests.notificationRef, posted.ref)
      ),
    });
    if (!request) return; // a reaction to some other message

    const user = await resolveClaimant(claimant);
    if (!user || !user.printSquad) {
      await notifier.postClaimFailed(
        posted,
        "Couldn't match your number to a print squad account, so this isn't claimed. Claim it on the website instead."
      );
      return;
    }

    const result = await claimPrintRequest(request.requestId, user);
    if (result.ok) {
      await notifier.postClaimed(posted, displayName(user));
      return;
    }
    if (result.reason === 'already_claimed' && result.request?.claimedByUserId) {
      const owner = await db.query.users.findFirst({
        where: eq(users.userId, result.request.claimedByUserId),
      });
      await notifier.postClaimFailed(
        posted,
        `Already claimed by ${owner ? displayName(owner) : 'someone else'}.`
      );
    } else if (result.reason === 'completed') {
      await notifier.postClaimFailed(posted, 'This request is already completed.');
    }
  });
}
