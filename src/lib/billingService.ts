import { db } from './db';
import { risographUsages, creditTransactions, creditBalances, users } from './schema';
import { eq, sum, desc, and, gte } from 'drizzle-orm';
import { getConfig } from './config';

export interface UsageSummary {
  copiesPrinted: number;
  stencilsCreated: number;
  copyChargesCents: number;
  stencilChargesCents: number;
  totalChargesCents: number;
}

export class BillingService {
  private copyPriceCents: number;
  private stencilPriceCents: number;

  constructor() {
    const config = getConfig();
    // Default prices if not configured: $0.10 per copy, $1.50 per stencil
    this.copyPriceCents = config.riso?.copyPriceCents || 10;
    this.stencilPriceCents = config.riso?.stencilPriceCents || 150;
  }

  calculateUsageCharges(copiesPrinted: number, stencilsCreated: number): UsageSummary {
    const copyChargesCents = copiesPrinted * this.copyPriceCents;
    const stencilChargesCents = stencilsCreated * this.stencilPriceCents;
    const totalChargesCents = copyChargesCents + stencilChargesCents;

    return {
      copiesPrinted,
      stencilsCreated,
      copyChargesCents,
      stencilChargesCents,
      totalChargesCents
    };
  }

  async createUsageTransaction(userId: number, copiesPrinted: number, stencilsCreated: number): Promise<void> {
    const charges = this.calculateUsageCharges(copiesPrinted, stencilsCreated);

    if (charges.totalChargesCents <= 0) {
      return; // No charges to create
    }

    const note = `Usage charges: ${copiesPrinted} copies ($${(charges.copyChargesCents / 100).toFixed(2)}), ${stencilsCreated} stencils ($${(charges.stencilChargesCents / 100).toFixed(2)})`;

    // Insert negative transaction (debit) - the existing trigger will update the balance automatically
    await db.insert(creditTransactions).values({
      userId,
      amountCents: -charges.totalChargesCents, // Negative because it's a charge/debit
      currency: 'USD',
      kind: 'usage_charge',
      note
    });
  }

  async getUserAccountBalance(userId: number): Promise<number> {
    const balance = await db.query.creditBalances.findFirst({
      where: eq(creditBalances.userId, userId)
    });

    return balance?.balanceCents || 0;
  }

  async getRecentUsageForUser(userId: number, limit: number = 20): Promise<Array<{
    timestamp: Date;
    copiesPrinted: number;
    stencilsCreated: number;
    chargeCents: number;
  }>> {
    const recentUsages = await db.query.risographUsages.findMany({
      where: eq(risographUsages.userId, userId),
      orderBy: desc(risographUsages.timestamp),
      limit
    });

    return recentUsages.map(usage => {
      const charges = this.calculateUsageCharges(usage.copiesPrinted, usage.stencilsCreated);
      return {
        timestamp: usage.timestamp,
        copiesPrinted: usage.copiesPrinted,
        stencilsCreated: usage.stencilsCreated,
        chargeCents: charges.totalChargesCents
      };
    });
  }

  getPricing(): { copyPriceCents: number; stencilPriceCents: number } {
    return {
      copyPriceCents: this.copyPriceCents,
      stencilPriceCents: this.stencilPriceCents
    };
  }
}

// Helper function to map Riso user identifiers to database user IDs
export async function mapRisoUserToDbUser(risoUserIdentifier: string): Promise<number | null> {
  if (risoUserIdentifier.includes('@')) {
    // Email lookup
    const user = await db.query.users.findFirst({
      where: eq(users.email, risoUserIdentifier)
    });
    return user?.userId || null;
  }

  // Try name lookup
  const user = await db.query.users.findFirst({
    where: eq(users.name, risoUserIdentifier)
  });

  return user?.userId || null;
}

// Singleton instance
let billingServiceInstance: BillingService | null = null;

export function getBillingService(): BillingService {
  if (!billingServiceInstance) {
    billingServiceInstance = new BillingService();
  }

  return billingServiceInstance;
}
