import {
  pgTable,
  bigserial,
  smallint,
  text,
  timestamp,
  boolean,
  serial,
  integer,
  bigint,
  char,
  check,
  customType,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// Custom PostgreSQL tstzrange type
const tstzrange = customType<{ data: string; notNull: false; default: false }>({
  dataType() {
    return 'tstzrange';
  },
});

export const users = pgTable(
  'users',
  {
    userId: bigserial('user_id', { mode: 'number' }).primaryKey(),
    name: text('name'),
    email: text('email').unique(),
    // passwordHash: text('password_hash').notNull(),
    phoneE164: text('phone_e164').notNull().unique(),
    code: text('code').notNull().unique(),
    verificationCode: text('verification_code'),
    verificationCodeExpires: timestamp('verification_code_expires', { withTimezone: true }),
    lastVerified: timestamp('last_verified', { withTimezone: true }),
    approved: boolean('approved').notNull().default(false),
    trained: boolean('trained').notNull().default(false),
    applicationReviewer: boolean('application_reviewer').notNull().default(false),
    printshop: boolean('printshop').notNull().default(false),
    eventCreator: boolean('event_creator').notNull().default(false),
    risoUsername: text('riso_username'), // Username on RISO machine for usage tracking
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => ({
    phoneCheckConstraint: check(
      'phone_check',
      sql`phone_e164 IS NULL OR phone_e164 ~ '^\\+[1-9][0-9]{7,15}$'`
    ),
  })
);

export const applications = pgTable('applications', {
  applicationId: bigserial('application_id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  phoneE164: text('phone_e164').notNull(),
  intendedUsage: text('intended_usage').notNull(),
  reference1Name: text('reference1_name').notNull(),
  reference1Phone: text('reference1_phone').notNull(),
  reference2Name: text('reference2_name').notNull(),
  reference2Phone: text('reference2_phone').notNull(),
  status: text('status').notNull().default('pending'), // 'pending', 'approved', 'rejected'
  reviewedBy: bigint('reviewed_by', { mode: 'number' }).references(() => users.userId),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewNotes: text('review_notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const units = pgTable('units', {
  unitId: serial('unit_id').primaryKey(),
  capacity: smallint('capacity').notNull(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
});

export const bookings = pgTable('bookings', {
  bookingId: bigserial('booking_id', { mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' })
    .notNull()
    .references(() => users.userId, { onDelete: 'cascade' }),
  unitId: integer('unit_id')
    .notNull()
    .references(() => units.unitId, { onDelete: 'cascade' }),
  slot: tstzrange('slot').notNull(),
  status: text('status').notNull().default('confirmed'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// An event is a set of timeslots: either a finite explicit list, or a
// recurrence rule (RRULE) materialized into event_timeslots over a rolling
// horizon. Printshop bookings are single-timeslot finite events created via
// the booking UI.
export const events = pgTable('events', {
  eventId: bigserial('event_id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  // NULL for events created from the admin panel (admins are not user rows)
  createdBy: bigint('created_by', { mode: 'number' }).references(() => users.userId, {
    onDelete: 'set null',
  }),
  kind: text('kind').notNull(), // 'finite' | 'recurring'
  // Set for printshop events so unit capacity / density calculations apply
  unitId: integer('unit_id').references(() => units.unitId, { onDelete: 'set null' }),
  // Recurring events only: full iCal string incl. DTSTART;TZID=..., wall-clock times
  rrule: text('rrule'),
  durationMinutes: integer('duration_minutes'),
  timezone: text('timezone'),
  status: text('status').notNull().default('active'), // 'active' | 'cancelled'
  // Provenance link for rows migrated from the legacy bookings table
  legacyBookingId: bigint('legacy_booking_id', { mode: 'number' }).unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const eventTimeslots = pgTable('event_timeslots', {
  timeslotId: bigserial('timeslot_id', { mode: 'number' }).primaryKey(),
  eventId: bigint('event_id', { mode: 'number' })
    .notNull()
    .references(() => events.eventId, { onDelete: 'cascade' }),
  slot: tstzrange('slot').notNull(),
  // true = produced by the rrule materializer (vs. explicitly listed)
  generated: boolean('generated').notNull().default(false),
  status: text('status').notNull().default('confirmed'), // 'confirmed' | 'cancelled'
});

// Which users may access the space during which events
export const eventPermissions = pgTable(
  'event_permissions',
  {
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    eventId: bigint('event_id', { mode: 'number' })
      .notNull()
      .references(() => events.eventId, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => ({
    pk: primaryKey({ columns: [table.userId, table.eventId] }),
  })
);

// A user's code is written to the lock only when they activate during a
// current occurrence. access_start/access_stop are the exact window sent in
// the addAccess broadcast; the daemon removes intervals by exact
// (code, start, stop) match, so these must be replayed verbatim.
// Append-only: rows are never deleted or overwritten — this is the permanent
// record of who was in the space when. Revocation (event cancelled,
// permission removed) sets revoked_at; re-activating afterwards inserts a
// new row. At most one unrevoked row per (user, timeslot) — enforced by a
// partial unique index in the migration SQL.
export const lockActivations = pgTable('lock_activations', {
  activationId: bigserial('activation_id', { mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' })
    .notNull()
    .references(() => users.userId, { onDelete: 'cascade' }),
  timeslotId: bigint('timeslot_id', { mode: 'number' })
    .notNull()
    .references(() => eventTimeslots.timeslotId, { onDelete: 'cascade' }),
  accessStart: timestamp('access_start', { withTimezone: true }).notNull(),
  accessStop: timestamp('access_stop', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const blackouts = pgTable('blackouts', {
  blackoutId: bigserial('blackout_id', { mode: 'number' }).primaryKey(),
  unitId: integer('unit_id')
    .notNull()
    .references(() => units.unitId, { onDelete: 'cascade' }),
  period: tstzrange('period').notNull(),
  reason: text('reason'),
});

export const creditPackages = pgTable('credit_packages', {
  packageId: serial('package_id').primaryKey(),
  name: text('name').notNull().unique(),
  creditCents: integer('credit_cents').notNull(),
  priceCents: integer('price_cents').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  active: boolean('active').notNull().default(true),
});

export const creditTransactions = pgTable('credit_transactions', {
  txId: bigserial('tx_id', { mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' })
    .notNull()
    .references(() => users.userId, { onDelete: 'cascade' }),
  amountCents: integer('amount_cents').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  kind: text('kind').notNull(),
  bookingId: bigint('booking_id', { mode: 'number' }).references(() => bookings.bookingId),
  paymentId: text('payment_id'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const creditBalances = pgTable('credit_balances', {
  userId: bigint('user_id', { mode: 'number' })
    .primaryKey()
    .references(() => users.userId, { onDelete: 'cascade' }),
  balanceCents: integer('balance_cents').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Indexes
// export const bookingsUserIdx = index('bookings_user_idx').on(bookings.userId, bookings.slot);
// export const creditTxUserIdx = index('credit_tx_user_idx').on(
//   creditTransactions.userId,
//   creditTransactions.createdAt
// );

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  bookings: many(bookings),
  creditTransactions: many(creditTransactions),
  creditBalance: many(creditBalances),
  reviewedApplications: many(applications),
  createdEvents: many(events),
  eventPermissions: many(eventPermissions),
  lockActivations: many(lockActivations),
}));

export const eventsRelations = relations(events, ({ one, many }) => ({
  creator: one(users, {
    fields: [events.createdBy],
    references: [users.userId],
  }),
  unit: one(units, {
    fields: [events.unitId],
    references: [units.unitId],
  }),
  timeslots: many(eventTimeslots),
  permissions: many(eventPermissions),
}));

export const eventTimeslotsRelations = relations(eventTimeslots, ({ one, many }) => ({
  event: one(events, {
    fields: [eventTimeslots.eventId],
    references: [events.eventId],
  }),
  lockActivations: many(lockActivations),
}));

export const eventPermissionsRelations = relations(eventPermissions, ({ one }) => ({
  user: one(users, {
    fields: [eventPermissions.userId],
    references: [users.userId],
  }),
  event: one(events, {
    fields: [eventPermissions.eventId],
    references: [events.eventId],
  }),
}));

export const lockActivationsRelations = relations(lockActivations, ({ one }) => ({
  user: one(users, {
    fields: [lockActivations.userId],
    references: [users.userId],
  }),
  timeslot: one(eventTimeslots, {
    fields: [lockActivations.timeslotId],
    references: [eventTimeslots.timeslotId],
  }),
}));

export const applicationsRelations = relations(applications, ({ one }) => ({
  reviewer: one(users, {
    fields: [applications.reviewedBy],
    references: [users.userId],
  }),
}));

export const unitsRelations = relations(units, ({ many }) => ({
  bookings: many(bookings),
  blackouts: many(blackouts),
  events: many(events),
}));

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  user: one(users, {
    fields: [bookings.userId],
    references: [users.userId],
  }),
  unit: one(units, {
    fields: [bookings.unitId],
    references: [units.unitId],
  }),
  creditTransactions: many(creditTransactions),
}));

export const blackoutsRelations = relations(blackouts, ({ one }) => ({
  unit: one(units, {
    fields: [blackouts.unitId],
    references: [units.unitId],
  }),
}));

export const creditPackagesRelations = relations(creditPackages, () => ({
  // Add relations if needed for credit package purchases
}));

export const creditTransactionsRelations = relations(creditTransactions, ({ one }) => ({
  user: one(users, {
    fields: [creditTransactions.userId],
    references: [users.userId],
  }),
  booking: one(bookings, {
    fields: [creditTransactions.bookingId],
    references: [bookings.bookingId],
  }),
}));

export const creditBalancesRelations = relations(creditBalances, ({ one }) => ({
  user: one(users, {
    fields: [creditBalances.userId],
    references: [users.userId],
  }),
}));

export const risographUsages = pgTable('risograph_usages', {
  usageId: bigserial('usage_id', { mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' })
    .notNull()
    .references(() => users.userId, { onDelete: 'cascade' }),
  copiesPrinted: integer('copies_printed').notNull().default(0),
  stencilsCreated: integer('stencils_created').notNull().default(0),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
  rawData: text('raw_data'), // Store scraped data for debugging
});

export const risographUsagesRelations = relations(risographUsages, ({ one }) => ({
  user: one(users, {
    fields: [risographUsages.userId],
    references: [users.userId],
  }),
}));

// Track last seen RISO totals to detect resets and calculate incremental usage
export const risoLastSeenTotals = pgTable('riso_last_seen_totals', {
  userId: bigint('user_id', { mode: 'number' })
    .primaryKey()
    .references(() => users.userId, { onDelete: 'cascade' }),
  lastSeenCopies: integer('last_seen_copies').notNull().default(0),
  lastSeenStencils: integer('last_seen_stencils').notNull().default(0),
  cumulativeCopiesBilled: integer('cumulative_copies_billed').notNull().default(0),
  cumulativeStencilsBilled: integer('cumulative_stencils_billed').notNull().default(0),
  lastReportDate: timestamp('last_report_date', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const risoLastSeenTotalsRelations = relations(risoLastSeenTotals, ({ one }) => ({
  user: one(users, {
    fields: [risoLastSeenTotals.userId],
    references: [users.userId],
  }),
}));
