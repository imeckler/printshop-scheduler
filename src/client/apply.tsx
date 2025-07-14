/** @jsx jsx */
/** @jsxFrag Fragment */
import { jsx, Fragment } from 'hono/jsx/dom';
import { render } from 'hono/jsx/dom';

class ApplicationManager {
  private form: HTMLFormElement;
  private submitBtn: HTMLButtonElement;

  constructor() {
    this.form = document.getElementById('applicationForm') as HTMLFormElement;
    this.submitBtn = document.getElementById('submitBtn') as HTMLButtonElement;

    if (this.form) {
      this.setupEventListeners();
    }
  }

  private setupEventListeners(): void {
    this.form.addEventListener('submit', this.handleSubmit.bind(this));
    
    // Add phone number formatting
    const phoneInputs = this.form.querySelectorAll('input[type="tel"]');
    phoneInputs.forEach(input => {
      input.addEventListener('input', this.formatPhoneNumber.bind(this));
    });
  }

  private formatPhoneNumber(event: Event): void {
    const input = event.target as HTMLInputElement;
    let value = input.value.replace(/\D/g, ''); // Remove non-digits
    
    // Add + prefix if not present
    if (value && !input.value.startsWith('+')) {
      input.value = '+' + value;
    }
  }

  private async handleSubmit(event: Event): Promise<void> {
    event.preventDefault();
    
    this.submitBtn.disabled = true;
    this.submitBtn.textContent = 'Submitting...';

    try {
      const formData = new FormData(this.form);
      const applicationData = {
        name: formData.get('name'),
        email: formData.get('email'),
        phone: formData.get('phone'),
        aboutBathing: formData.get('aboutBathing'),
        intendedUsage: formData.get('intendedUsage'),
        reference1Name: formData.get('reference1Name'),
        reference1Phone: formData.get('reference1Phone'),
        reference2Name: formData.get('reference2Name'),
        reference2Phone: formData.get('reference2Phone'),
      };

      const response = await fetch('/submit-application', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(applicationData),
      });

      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          // Redirect to success page
          window.location.href = '/apply?success=true';
        } else {
          this.showError(result.error || 'Failed to submit application');
        }
      } else {
        const errorResult = await response.json();
        this.showError(errorResult.error || 'Failed to submit application');
      }
    } catch (error) {
      console.error('Error submitting application:', error);
      this.showError('Network error. Please try again.');
    } finally {
      this.submitBtn.disabled = false;
      this.submitBtn.textContent = 'Submit Application';
    }
  }

  private showError(message: string): void {
    // Remove existing error alerts
    const existingAlerts = document.querySelectorAll('.alert-danger');
    existingAlerts.forEach(alert => alert.remove());

    // Create new error alert
    const errorAlert = (
      <div className="alert alert-danger">
        {message}
      </div>
    );

    const container = document.querySelector('.container');
    const h2 = container?.querySelector('h2');
    if (h2 && h2.nextSibling) {
      const tempDiv = document.createElement('div');
      render(errorAlert, tempDiv);
      if (tempDiv.firstElementChild) {
        h2.parentNode?.insertBefore(tempDiv.firstElementChild, h2.nextSibling);
      }
    }

    // Scroll to top to show error
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new ApplicationManager();
});