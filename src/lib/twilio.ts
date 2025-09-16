import twilio from 'twilio';
import { getConfig, TwilioConfig } from './config';
import { randomInt } from 'crypto';
import { User } from './dbtypes';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { users } from './schema';

const config = getConfig();

export type VerificationResult =
  | { status: 'failed' }
  | { status: 'ok'; record: User; newUser: boolean };

class TwilioService {
  private client: twilio.Twilio | null = null;
  private verifySid: string = '';
  private messagingServiceSid: string = '';
  private isEnabled: boolean = true;
  private fromPhoneNumber: string = '';

  constructor() {
    const twilioConfig = config.twilio as TwilioConfig;

    this.isEnabled = !!twilioConfig && !!twilioConfig.account_sid && !!twilioConfig.auth_token;

    if (this.isEnabled) {
      this.client = twilio(twilioConfig.account_sid, twilioConfig.auth_token);
      this.verifySid = twilioConfig.verify_service_sid;
      this.messagingServiceSid = twilioConfig.messaging_service_sid;
      this.fromPhoneNumber = twilioConfig.phone_number;
    }
  }

  /**
   * Generates a random verification code
   * @returns A 6-digit verification code
   */
  generateVerificationCode(): string {
    return randomInt(100000, 999999).toString();
  }

  /**
   * Generates a random user code
   * @returns A 6-digit user code
   */
  generateUserCode(): string {
    return randomInt(100000, 999999).toString();
  }

  /**
   * Check if a phone number has been previously verified in the database
   * and can skip expensive Twilio Verify API
   * @param phoneNumber The phone number to check
   * @returns Promise that resolves to true if the phone has been verified before
   */
  async hasDoneExpensiveVerification(phoneNumber: string): Promise<boolean> {
    try {
      const userRecord = await db.query.users.findFirst({
        where: eq(users.phoneE164, phoneNumber),
      });
      return userRecord != null;
    } catch (error) {
      console.error('Error checking phone verification status:', error);
      return false;
    }
  }

  /**
   * Sends a verification code to the provided phone number
   * Uses Twilio Verify API for first-time verification,
   * or a simpler SMS for previously verified numbers
   *
   * @param phoneNumber The phone number to send the verification code to
   * @returns Promise that resolves with the verification code if using SMS, null if using Verify API
   */
  async sendVerificationCode(phoneNumber: string): Promise<string | null> {
    if (!this.isEnabled) {
      console.log('Twilio is not configured. Skipping verification.');
      return null;
    } else if (!this.client) {
      throw 'Twilio enabled but client not present.';
    }

    try {
      // Check if the phone number has been verified before
      const hasBeenVerified = await this.hasDoneExpensiveVerification(phoneNumber);
      console.log('hasBeenVerified', hasBeenVerified);

      if (hasBeenVerified) {
        // For previously verified numbers, generate and send our own code
        const code = this.generateVerificationCode();

        const [userRecord] = await db
          .update(users)
          .set({
            verificationCode: code,
            // Set the verification code with a 10-minute expiry
            verificationCodeExpires: new Date(Date.now() + 10 * 60 * 1000),
          })
          .where(eq(users.phoneE164, phoneNumber))
          .returning();

        if (!userRecord) {
          throw 'error';
        }

        // Send the code via regular SMS
        // Use messaging service if configured, otherwise use from phone number
        if (this.messagingServiceSid) {
          await this.client.messages.create({
            body: `Your verification code for ContraBanya is: ${code}`,
            to: phoneNumber,
            messagingServiceSid: this.messagingServiceSid,
          });
        } else {
          await this.client.messages.create({
            body: `Your verification code for ContraBanya is: ${code}`,
            to: phoneNumber,
            from: this.fromPhoneNumber,
          });
        }

        return code;
      } else {
        // For first-time verification, use the Verify API
        if (!this.verifySid) {
          console.error('Verify service SID not configured');
          return null;
        }

        await this.client.verify.v2
          .services(this.verifySid)
          .verifications.create({ to: phoneNumber, channel: 'sms' });

        return null; // No code to return, Twilio Verify handles it
      }
    } catch (error) {
      console.error('Error sending verification code:', error);
      throw error;
    }
  }

  /**
   * Checks if the provided code matches the verification code
   * Uses Twilio Verify API for first-time verification,
   * or checks against our stored code for previously verified numbers
   *
   * @param phoneNumber The phone number to verify
   * @param code The verification code to check
   * @param name Optional name to associate with this phone number
   * @param email Optional email to associate with this phone number
   * @returns Promise that resolves with verification success status
   */
  async checkVerificationCode(phoneNumber: string, code: string): Promise<VerificationResult> {
    if (!this.client) {
      throw 'Twilio enabled but client not present.';
    }

    try {
      // Check if the phone number has been verified before
      const userRecord = await db.query.users.findFirst({
        where: eq(users.phoneE164, phoneNumber),
      });

      if (userRecord != null) {
        if (!userRecord.verificationCode || !userRecord.verificationCodeExpires) {
          // throw new Error(`verification code not found for ${phoneNumber}`);
          return { status: 'failed' };
        }

        // For previously verified numbers, check against our database
        if (userRecord.verificationCode != code) {
          return { status: 'failed' };
        }

        if (userRecord.verificationCodeExpires > new Date()) {
          // Update verification status and clear code
          userRecord.lastVerified = new Date();
          userRecord.verificationCode = null;
          userRecord.verificationCodeExpires = null;

          const res = await db
            .update(users)
            .set({
              lastVerified: new Date(),
              verificationCode: null,
              verificationCodeExpires: null,
            })
            .where(eq(users.userId, userRecord.userId))
            .execute();
          if (res.rowCount == 1) {
            return { record: userRecord, status: 'ok', newUser: false };
          } else {
            throw new Error(`update failed ${phoneNumber}`);
          }
        } else {
          return { status: 'failed' };
        }
      } else {
        // For first-time verification, use the Verify API
        if (!this.verifySid) {
          console.error('Verify service SID not configured');
          return { status: 'failed' };
        }

        const verificationCheck = await this.client.verify.v2
          .services(this.verifySid)
          .verificationChecks.create({ to: phoneNumber, code });

        if (verificationCheck.status === 'approved') {
          // Create a new verified user record with approved flag set to false initially
          let userRecord;
          let attempts = 0;
          
          while (attempts < 10) {
            try {
              const code = this.generateUserCode();
              [userRecord] = await db
                .insert(users)
                .values({
                  phoneE164: phoneNumber,
                  code: code,
                  lastVerified: new Date(),
                  approved: false,
                })
                .returning();
              break;
            } catch (error) {
              attempts++;
              if (attempts >= 10 || !(error instanceof Error && error.message.includes('code'))) {
                throw error;
              }
            }
          }

          if (!userRecord) {
            return { status: 'failed' };
          }

          return { status: 'ok', newUser: true, record: userRecord };
        }

        return { status: 'failed' };
      }
    } catch (error) {
      console.error('Error checking verification code:', error);
      return { status: 'failed' };
    }
  }
}

export default new TwilioService();
