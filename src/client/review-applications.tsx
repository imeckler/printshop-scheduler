/** @jsx jsx */
/** @jsxFrag Fragment */
import { jsx, Fragment } from 'hono/jsx/dom';
import { render } from 'hono/jsx/dom';

class ApplicationReviewManager {
  constructor() {
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // Handle approve/reject button clicks
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      
      if (target.classList.contains('approve-btn') || target.classList.contains('reject-btn')) {
        event.preventDefault();
        this.handleReviewAction(target);
      }
    });
  }

  private async handleReviewAction(button: HTMLElement): Promise<void> {
    const action = button.dataset.action as 'approve' | 'reject';
    const form = button.closest('.review-form') as HTMLFormElement;
    const applicationId = parseInt(form.dataset.applicationId!);
    const reviewNotesTextarea = form.querySelector('textarea[name="reviewNotes"]') as HTMLTextAreaElement;
    const reviewNotes = reviewNotesTextarea.value.trim();

    // Disable all buttons in this form
    const buttons = form.querySelectorAll('button');
    buttons.forEach(btn => {
      btn.disabled = true;
      if (btn === button) {
        btn.textContent = action === 'approve' ? 'Approving...' : 'Rejecting...';
      }
    });

    try {
      const response = await fetch('/review-application', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          applicationId,
          action,
          reviewNotes: reviewNotes || undefined,
        }),
      });

      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          this.showSuccess(result.message);
          // Remove the application card from the page
          const applicationCard = button.closest('.application-card');
          if (applicationCard) {
            applicationCard.remove();
          }
          // Update the pending count
          this.updatePendingCount();
        } else {
          this.showError(result.error || 'Failed to review application');
          this.resetButtons(form, action);
        }
      } else {
        const errorResult = await response.json();
        this.showError(errorResult.error || 'Failed to review application');
        this.resetButtons(form, action);
      }
    } catch (error) {
      console.error('Error reviewing application:', error);
      this.showError('Network error. Please try again.');
      this.resetButtons(form, action);
    }
  }

  private resetButtons(form: HTMLFormElement, action: 'approve' | 'reject'): void {
    const buttons = form.querySelectorAll('button');
    buttons.forEach(btn => {
      btn.disabled = false;
      if (btn.dataset.action === action) {
        btn.textContent = action === 'approve' ? 'Approve' : 'Reject';
      }
    });
  }

  private updatePendingCount(): void {
    const remainingCards = document.querySelectorAll('.application-card').length;
    const header = document.querySelector('h3');
    if (header && header.textContent?.includes('Pending Applications')) {
      header.textContent = `Pending Applications (${remainingCards})`;
    }

    // Show "no pending applications" message if none left
    if (remainingCards === 0) {
      const reviewSection = document.querySelector('.review-section');
      if (reviewSection) {
        const noAppsMessage = document.createElement('p');
        noAppsMessage.className = 'no-applications';
        noAppsMessage.textContent = 'No pending applications at this time.';
        reviewSection.appendChild(noAppsMessage);
      }
    }
  }

  private showSuccess(message: string): void {
    this.showAlert(message, 'success');
  }

  private showError(message: string): void {
    this.showAlert(message, 'danger');
  }

  private showAlert(message: string, type: 'success' | 'danger'): void {
    // Remove existing alerts
    const existingAlerts = document.querySelectorAll('.alert');
    existingAlerts.forEach(alert => alert.remove());

    // Create new alert
    const alertEl = (
      <div className={`alert alert-${type}`}>
        {message}
      </div>
    );

    const container = document.querySelector('.container');
    const h2 = container?.querySelector('h2');
    if (h2 && h2.nextSibling) {
      const tempDiv = document.createElement('div');
      render(alertEl, tempDiv);
      if (tempDiv.firstElementChild) {
        h2.parentNode?.insertBefore(tempDiv.firstElementChild, h2.nextSibling);
      }
    }

    // Auto-remove success alerts after 5 seconds
    if (type === 'success') {
      setTimeout(() => {
        const alert = document.querySelector('.alert-success');
        if (alert) alert.remove();
      }, 5000);
    }

    // Scroll to top to show alert
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new ApplicationReviewManager();
});