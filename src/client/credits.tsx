/** @jsx jsx */
/** @jsxFrag Fragment */
import { jsx, Fragment } from 'hono/jsx/dom';
import { render } from 'hono/jsx/dom';

class CreditManager {
  private amountInput: HTMLInputElement;
  private feeBreakdown: HTMLElement;
  private addCreditsBtn: HTMLButtonElement;
  private creditAmountDisplay: HTMLElement;
  private stripeFeeDisplay: HTMLElement;
  private totalChargeDisplay: HTMLElement;

  constructor() {
    this.amountInput = document.getElementById('creditAmount') as HTMLInputElement;
    this.feeBreakdown = document.getElementById('feeBreakdown') as HTMLElement;
    this.addCreditsBtn = document.getElementById('addCreditsBtn') as HTMLButtonElement;
    this.creditAmountDisplay = document.getElementById('creditAmountDisplay') as HTMLElement;
    this.stripeFeeDisplay = document.getElementById('stripeFeeDisplay') as HTMLElement;
    this.totalChargeDisplay = document.getElementById('totalChargeDisplay') as HTMLElement;

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.amountInput.addEventListener('input', this.handleAmountChange.bind(this));
    this.addCreditsBtn.addEventListener('click', this.handleAddCredits.bind(this));
  }

  private handleAmountChange(): void {
    const amount = parseFloat(this.amountInput.value);
    
    if (isNaN(amount) || amount < 5) {
      this.feeBreakdown.style.display = 'none';
      this.addCreditsBtn.disabled = true;
      return;
    }

    // Calculate Stripe fee: 2.9% + $0.30
    const amountCents = Math.round(amount * 100);
    const stripeFeePercent = Math.round(amountCents * 0.029);
    const stripeFixedFeeCents = 30;
    const totalStripeFee = stripeFeePercent + stripeFixedFeeCents;
    const totalChargeCents = amountCents + totalStripeFee;

    // Update displays
    this.creditAmountDisplay.textContent = `$${(amountCents / 100).toFixed(2)}`;
    this.stripeFeeDisplay.textContent = `$${(totalStripeFee / 100).toFixed(2)}`;
    this.totalChargeDisplay.textContent = `$${(totalChargeCents / 100).toFixed(2)}`;

    this.feeBreakdown.style.display = 'block';
    this.addCreditsBtn.disabled = false;
  }

  private async handleAddCredits(): Promise<void> {
    const amount = parseFloat(this.amountInput.value);
    
    if (isNaN(amount) || amount < 5) {
      alert('Please enter a valid amount (minimum $5)');
      return;
    }

    // Disable button to prevent double-clicks
    this.addCreditsBtn.disabled = true;
    this.addCreditsBtn.textContent = 'Processing...';

    try {
      // Calculate the total amount including Stripe fees
      const amountCents = Math.round(amount * 100);
      const stripeFeePercent = Math.round(amountCents * 0.029);
      const stripeFixedFeeCents = 30;
      const totalStripeFee = stripeFeePercent + stripeFixedFeeCents;
      const totalChargeCents = amountCents + totalStripeFee;

      // Create checkout session
      const response = await fetch('/create-checkout-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          creditAmountCents: amountCents,
          totalChargeCents: totalChargeCents,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create checkout session');
      }

      const { url } = await response.json();
      window.location.href = url;

    } catch (error) {
      console.error('Payment error:', error);
      alert('Failed to process payment. Please try again.');
    } finally {
      // Re-enable button
      this.addCreditsBtn.disabled = false;
      this.addCreditsBtn.textContent = 'Add Credits';
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new CreditManager();
});