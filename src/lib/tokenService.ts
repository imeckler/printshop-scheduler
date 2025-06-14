import jwt from 'jsonwebtoken';
import { getConfig } from './config.js';
import { User } from './dbtypes';
import { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { users } from './schema';

const config = getConfig();

export function getVerifiedPhoneFromRequest(req: FastifyRequest): string | null {
  // Get the verification token from the request
  const verificationToken =
    req.cookies?.phone_verification || (req.headers['x-phone-verification'] as string);

  if (!verificationToken) {
    return null;
  }

  const decoded = verifyPhoneVerificationToken(verificationToken);
  if (!decoded) {
    return null;
  }

  return decoded.phone;
}

export function getVerifiedUserIdFromRequest(req: FastifyRequest): number | null {
  // Get the verification token from the request
  const verificationToken =
    req.cookies?.phone_verification || (req.headers['x-phone-verification'] as string);

  if (!verificationToken) {
    return null;
  }

  const decoded = verifyPhoneVerificationToken(verificationToken);
  if (!decoded) {
    return null;
  }

  return decoded.userId;
}

// Token types for phone verification - enhanced with user info
export type PhoneVerificationTokenPayload = {
  type: 'phone_verification';
  phone: string;
  userId: number;
  name?: string;
  email?: string;
  iat: number;
  exp: number;
};

/**
 * Generate a JWT token for phone verification
 * This token will be stored in a cookie and used to authenticate verified phone numbers
 * Now includes optional user name and email
 */
export function generatePhoneVerificationToken(
  phone: string,
  userId: number,
  name?: string,
  email?: string
): string {
  // Use JWT secret from config or generate a random one
  const jwtSecret = config.jwt.secret;

  // Create payload with the verified phone number and optional user info
  const payload: Omit<PhoneVerificationTokenPayload, 'iat' | 'exp'> = {
    type: 'phone_verification',
    phone,
    userId,
    name,
    email,
  };

  // Generate token with 7-day expiration
  return jwt.sign(payload, jwtSecret, { expiresIn: '7d' });
}

/**
 * Verify a phone verification token
 * Returns the decoded token payload if valid, null otherwise
 * The jwt.verify function already checks that the token has not expired
 */
export function verifyPhoneVerificationToken(token: string): PhoneVerificationTokenPayload | null {
  const jwtSecret = config.jwt?.secret || 'gathio-verification-secret';

  try {
    const decoded = jwt.verify(token, jwtSecret) as PhoneVerificationTokenPayload;

    // Ensure the token is a phone verification token
    if (decoded.type !== 'phone_verification') {
      return null;
    }

    return decoded;
  } catch (error) {
    console.error('Error verifying token:', error);
    return null;
  }
}

/**
 * Extract the verified phone number from a token
 * Returns the phone number if valid, null otherwise
 */
export function getVerifiedPhoneFromToken(token: string): string | null {
  const decoded = verifyPhoneVerificationToken(token);

  if (!decoded) {
    return null;
  }

  return decoded.phone;
}

/**
 * Store verified user information in the database
 * This creates or updates a VerifiedUser record
 */
export async function storeVerifiedUser(
  phone: string,
  name: string,
  email?: string
): Promise<User> {
  try {
    // Try to find an existing user first
    const existingUser = await db.query.users.findFirst({
      where: eq(users.phoneE164, phone),
    });

    if (existingUser) {
      const [user] = await db
        .update(users)
        .set({
          name,
          email,
        })
        .where(eq(users.userId, existingUser.userId))
        .returning();
      return user;
    } else {
      throw new Error('No existing user');
    }
  } catch (error) {
    console.error('Error storing verified user:', error);
    throw error;
  }
}

/**
 * Get verified user information from the database
 * Returns the user if found, null otherwise
 */
export async function getVerifiedUser(phone: string): Promise<User | null> {
  try {
    const res = await db.query.users.findFirst({
      where: eq(users.phoneE164, phone),
    });
    return res || null;
  } catch (error) {
    console.error('Error retrieving verified user:', error);
    return null;
  }
}

/**
 * Get verified user information from a token
 * This combines verifying the token and retrieving the user from the database
 */
export async function getUserFromToken(token: string): Promise<User | null> {
  const decoded = verifyPhoneVerificationToken(token);

  if (!decoded) {
    return null;
  }

  return await getVerifiedUser(decoded.phone);
}
