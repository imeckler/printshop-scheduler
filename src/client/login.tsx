/** @jsx jsx */
/** @jsxFrag Fragment */
import { jsx, Fragment } from 'hono/jsx/dom';
import { render } from 'hono/jsx/dom';
import { sendVerification, checkVerification, isSuccessResponse } from './apiClient';

class LoginManager {
  private messageDiv: HTMLElement;
  private loginForm: HTMLFormElement;
  private verificationForm: HTMLElement;
  private phoneNumberInput: HTMLInputElement;
  private verificationCodeInput: HTMLInputElement;

  constructor() {
    this.messageDiv = document.getElementById('message') as HTMLElement;
    this.loginForm = document.getElementById('loginForm') as HTMLFormElement;
    this.verificationForm = document.getElementById('verificationForm') as HTMLElement;
    this.phoneNumberInput = document.getElementById('phoneNumber') as HTMLInputElement;
    this.verificationCodeInput = document.getElementById('verificationCode') as HTMLInputElement;

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.loginForm.addEventListener('submit', this.handleSendVerification.bind(this));

    const verifyForm = document.getElementById('verifyForm') as HTMLFormElement;
    verifyForm.addEventListener('submit', this.handleVerifyCode.bind(this));
  }

  private async handleSendVerification(e: Event): Promise<void> {
    e.preventDefault();

    // const phoneNumber = this.phoneNumberInput.value;
    const phoneNumber = (window as any).signInTel.getNumber();

    try {
      const result = await sendVerification({ phoneNumber });

      if (isSuccessResponse(result)) {
        this.showMessage('Verification code sent successfully!', 'success');
        this.verificationForm.style.display = 'block';
        this.verificationCodeInput.focus();
      } else {
        this.showMessage('Error: ' + result.error, 'error');
      }
    } catch (error) {
      this.showMessage('Network error. Please try again.', 'error');
    }
  }

  private async handleVerifyCode(e: Event): Promise<void> {
    e.preventDefault();

    const phoneNumber = (window as any).signInTel.getNumber();
    const code = this.verificationCodeInput.value;

    try {
      const result = await checkVerification({ phoneNumber, code });

      if (isSuccessResponse(result)) {
        this.showMessage('Verification successful! Redirecting...', 'success');
        setTimeout(() => {
          window.location.href = '/';
        }, 1000);
      } else {
        this.showMessage('Error: ' + result.error, 'error');
      }
    } catch (error) {
      this.showMessage('Network error. Please try again.', 'error');
    }
  }

  private showMessage(message: string, type: 'success' | 'error'): void {
    const color = type === 'success' ? 'green' : 'red';
    const messageElement = <p style={`color: ${color};`}>{message}</p>;

    this.messageDiv.innerHTML = '';
    render(messageElement, this.messageDiv);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new LoginManager();
});
