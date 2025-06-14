import { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import { users, bookings, creditTransactions } from './schema';

// Select types (what you get from queries)
export type User = InferSelectModel<typeof users>;
export type Booking = InferSelectModel<typeof bookings>;
export type CreditTransaction = InferSelectModel<typeof creditTransactions>;

// Insert types (what you pass to inserts, with optional fields)
export type NewUser = InferInsertModel<typeof users>;
export type NewBooking = InferInsertModel<typeof bookings>;
export type NewCreditTransaction = InferInsertModel<typeof creditTransactions>;
