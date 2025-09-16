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
