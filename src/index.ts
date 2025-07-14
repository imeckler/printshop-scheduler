import fastify from 'fastify';
import cookie from '@fastify/cookie';
import view from '@fastify/view';
import staticFiles from '@fastify/static';
import handlebars from 'handlebars';
import { FastifyRequest, FastifyReply } from 'fastify';
import path from 'path';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { initializeDatabase } from './lib/db';
import twilioService from './lib/twilio';
import { generateAdminToken, verifyAdminToken, generatePhoneVerificationToken, getVerifiedUserIdFromRequest } from './lib/tokenService';
import { User } from './lib/dbtypes';
import { SaunaAvailabilityManager } from './lib/availability';
import { db } from './lib/db';
import { bookings, users, creditBalances, creditTransactions, creditPackages, applications } from './lib/schema';
import { eq, desc, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { getConfig } from './lib/config';
import { CookieSerializeOptions } from '@fastify/cookie';

const server = fastify().withTypeProvider<TypeBoxTypeProvider>();

// Add validation error handler
server.setErrorHandler((error, request, reply) => {
  if (error.validation) {
    console.log('Validation error:', error.validation);
    console.log('Request body:', request.body);
    reply.status(400).send({
      error: 'Validation failed',
      details: error.validation
    });
    return;
  }
  
  console.error('Server error:', error);
  reply.status(500).send({ error: 'Internal server error' });
});

// Register cookie plugin
server.register(cookie);

// Register form parser for HTML forms
server.register(require('@fastify/formbody'));

// Add content type parser for Stripe webhooks (need raw body for signature verification)
server.addContentTypeParser('application/json', { parseAs: 'buffer' }, function (req, body, done) {
  try {
    const json = JSON.parse(body.toString());
    // Store raw body for webhook signature verification
    (req as any).rawBody = body;
    done(null, json);
  } catch (err) {
    done(err instanceof Error ? err : new Error('Parse error'));
  }
});

// Register static files
server.register(staticFiles, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/public/',
});

// Register Handlebars helpers
handlebars.registerHelper('formatCurrency', function(cents: number) {
  return (cents / 100).toFixed(2);
});

handlebars.registerHelper('formatDate', function(date: Date) {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
});

handlebars.registerHelper('formatDateTime', function(date: Date) {
  return new Date(date).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
});

handlebars.registerHelper('eq', function(a: any, b: any) {
  return a === b;
});

handlebars.registerHelper('gt', function(a: number, b: number) {
  return a > b;
});

handlebars.registerHelper('subtract', function(a: number, b: number) {
  return a - b;
});

// Register view engine
server.register(view, {
  engine: {
    handlebars: handlebars,
  },
  root: path.join(__dirname, '..', 'views'),
  layout: './layouts/main',
});

// Initialize availability manager
const availabilityManager = new SaunaAvailabilityManager();

// shared auth function
function requirePermissions(perms: Array<{ [K in keyof User]: User[K] extends boolean ? K : never }[keyof User]>) {
  return async function authorize(request: FastifyRequest, reply: FastifyReply) {
    const userId = getVerifiedUserIdFromRequest(request);
    if (!userId) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.userId, userId)
    });
    if (!user) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    request.user = user;

    const ok = (request.cookies?.admin_session && verifyAdminToken(request.cookies.admin_session)) || perms.every((k) => user[k]);
    if (!ok) return reply.code(403).send({ error: 'Forbidden' });
  }
}

// Initialize config and Stripe
const config = getConfig();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-05-28.basil',
});

server.get('/ping', async (request, reply) => {
  return 'pong\n';
});

server.get('/', async (request, reply) => {
  const userId = getVerifiedUserIdFromRequest(request);
  
  if (userId) {
    // Get user details to check approval status
    const user = await db.query.users.findFirst({
      where: eq(users.userId, userId)
    });
    
    if (!user) {
      reply.clearCookie('phone_verification');
      return reply.redirect('/login');
    }
    
    console.log(user);
    // If user is approved, show normal homepage
    if (user.approved) {
      return reply.view('home', {
        user: { id: userId, name: user.name },
        upcomingBookings: []
      });
    }
    
    // If user is not approved, check their application status
    const application = await db.query.applications.findFirst({
      where: eq(applications.phoneE164, user.phoneE164)
    });
    
    if (!application) {
      // No application submitted - redirect to application form
      return reply.redirect('/apply');
    } else {
      // Application exists - show status page
      return reply.view('application-status', {
        user: { id: userId, name: user.name },
        application: {
          status: application.status,
          submittedAt: application.createdAt,
          reviewedAt: application.reviewedAt,
          reviewNotes: application.reviewNotes
        }
      });
    }
  } else {
    return reply.view('home', {});
  }
});

server.get('/login', async (request, reply) => {
  const userId = getVerifiedUserIdFromRequest(request);
  
  if (userId) {
    return reply.redirect('/');
  }
  
  return reply.view('login', {});
});

server.get('/apply', async (request, reply) => {
  const { success } = request.query as { success?: string };
  
  return reply.view('apply', {
    success: success === 'true'
  });
});

server.get('/admin', async (request, reply) => {
  const { success, error } = request.query as { success?: string; error?: string };
  
  // Check if admin is already logged in
  const adminToken = request.cookies.admin_session;
  if (adminToken && verifyAdminToken(adminToken)) {
    return reply.redirect('/admin/dashboard');
  }
  
  return reply.view('admin-login', {
    success: success === 'true',
    error: error === 'invalid' ? 'Invalid password' : undefined
  });
});

server.post('/admin/login', async (request, reply) => {
  const { password } = request.body as { password: string };
  
  const cookieOpts: CookieSerializeOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
    path: '/'
  };

  if (password === process.env.ADMIN_PASSWORD) {
    // Force clear the cookie by setting it to expire immediately
    reply.setCookie('admin_session', '', { ...cookieOpts, maxAge: 0 });
    console.log('yo nice');
    // Set admin session cookie
    const adminToken = generateAdminToken();
    
    reply.setCookie('admin_session', adminToken, cookieOpts);

    console.log('redirecting');
    return reply.redirect('/admin/dashboard');
  } else {
    return reply.redirect('/admin?error=invalid');
  }
});

server.get('/admin/dashboard', async (request, reply) => {
  // Check admin authentication
  const adminToken = request.cookies.admin_session;
  
  if (!adminToken || !verifyAdminToken(adminToken)) {
    return reply.redirect('/admin');
  }
  
  try {
    // Get system statistics
    const stats = await Promise.all([
      db.query.users.findMany().then(users => users.length),
      db.query.applications.findMany({ where: eq(applications.status, 'pending') }).then(apps => apps.length),
      db.query.applications.findMany({ where: eq(applications.status, 'approved') }).then(apps => apps.length),
      db.query.applications.findMany({ where: eq(applications.status, 'rejected') }).then(apps => apps.length),
      db.query.bookings.findMany().then(bookings => bookings.length),
    ]);
    
    const [totalUsers, pendingApps, approvedApps, rejectedApps, totalBookings] = stats;
    
    // Get recent activity
    const recentApplications = await db.query.applications.findMany({
      orderBy: desc(applications.createdAt),
      limit: 10
    });
    
    const recentUsers = await db.query.users.findMany({
      orderBy: desc(users.createdAt),
      limit: 10
    });
    
    return reply.view('admin-dashboard', {
      stats: {
        totalUsers,
        pendingApps,
        approvedApps,
        rejectedApps,
        totalBookings
      },
      recentApplications,
      recentUsers
    });
  } catch (error) {
    console.error('Error loading admin dashboard:', error);
    return reply.view('admin-dashboard', {
      stats: { totalUsers: 0, pendingApps: 0, approvedApps: 0, rejectedApps: 0, totalBookings: 0 },
      recentApplications: [],
      recentUsers: [],
      error: 'Failed to load dashboard data'
    });
  }
});

server.post('/admin/logout', async (request, reply) => {
  reply.clearCookie('admin_session');
  return reply.redirect('/admin');
});

server.get('/review-applications', { preHandler: requirePermissions(['applicationReviewer']) }, async (request, reply) => {
  try {
    const pendingApplications = await db.query.applications.findMany({
      where: eq(applications.status, 'pending'),
      orderBy: applications.createdAt
    });
    
    const recentReviewed = await db.query.applications.findMany({
      where: sql`status IN ('approved', 'rejected')`,
      orderBy: desc(applications.reviewedAt),
      limit: 20,
      with: {
        reviewer: {
          columns: {
            name: true,
            phoneE164: true
          }
        }
      }
    });
    
    return reply.view('review-applications', {
      user: { id: request.user!.userId, name: request.user!.name },
      pendingApplications,
      recentReviewed
    });
  } catch (error) {
    console.error('Error fetching applications:', error);
    return reply.view('review-applications', {
      user: { id: request.user!.userId, name: request.user!.name },
      pendingApplications: [],
      recentReviewed: [],
      error: 'Failed to load applications'
    });
  }
});

server.get('/book', { preHandler: requirePermissions(['approved', 'trained']) }, async (request, reply) => {
  return reply.view('booking', {
    user: { id: request.user!.userId, name: request.user!.name}
  });
});

server.get('/my-bookings', { preHandler: requirePermissions(['approved']) }, async (request, reply) => {
  const userId = request.user!.userId;
  try {
    const bookings = await availabilityManager.getUserBookings(userId);

    // Separate upcoming and past bookings
    const now = new Date();
    const upcomingBookings = bookings.filter(booking => new Date(booking.slot.split(',')[1].slice(0, -1)) > now);
    const pastBookings = bookings.filter(booking => new Date(booking.slot.split(',')[1].slice(0, -1)) <= now);

    return reply.view('my-bookings', {
      user: { id: userId, name: request.user!.name},
      bookings: upcomingBookings,
      pastBookings: pastBookings
    });
  } catch (error) {
    console.error('Error fetching user bookings:', error);
    return reply.view('my-bookings', {
      user: { id: userId, name: request.user!.name },
      bookings: [],
      pastBookings: [],
      error: 'Failed to load bookings'
    });
  }
});

server.get('/credits', { preHandler: requirePermissions(['approved']) }, async (request, reply) => {
  const userId = request.user!.userId;

  try {
    // Get user's credit balance
    const balance = await db.query.creditBalances.findFirst({
      where: eq(creditBalances.userId, userId)
    });
    
    // Get recent credit transactions
    const transactions = await db.query.creditTransactions.findMany({
      where: eq(creditTransactions.userId, userId),
      orderBy: desc(creditTransactions.createdAt),
      limit: 20
    });
    
    return reply.view('credits', {
      user: { id: userId, name: request.user!.name },
      balance: balance?.balanceCents || 0,
      transactions
    });
  } catch (error) {
    console.error('Error fetching credit data:', error);
    return reply.view('credits', {
      user: { id: userId, name: request.user!.name },
      balance: 0,
      transactions: [],
      error: 'Failed to load credit information'
    });
  }
});

server.get('/cancel-booking/:id', { preHandler: requirePermissions(['approved', 'trained']) }, async (request, reply) => {
  const userId = request.user!.userId;
  
  const { id } = request.params as { id: string };

  const booking = await db.query.bookings.findFirst({
    where: eq(bookings.bookingId, parseInt(id, 10))
  });

  return reply.view('cancel-booking', {
    user: { id: userId, name: request.user!.name },
    booking,
  });
});

server.post('/cancel-booking/:id', { preHandler: requirePermissions(['approved', 'trained']) }, async (request, reply) => {
  const userId = request.user!.userId;
  const { id } = request.params as { id: string };
  const bookingId = parseInt(id, 10);
  
  if (isNaN(bookingId)) {
    return reply.redirect('/my-bookings');
  }
  
  try {
    const success = await availabilityManager.cancelBooking(bookingId, userId);
    
    if (success) {
      return reply.redirect('/my-bookings?cancelled=true');
    } else {
      return reply.redirect('/my-bookings?error=cancel-failed');
    }
  } catch (error) {
    console.error('Error cancelling booking:', error);
    return reply.redirect('/my-bookings?error=cancel-failed');
  }
});

server.get('/logout', async (request, reply) => {
  reply.clearCookie('phone_verification');
  return reply.redirect('/');
});

const SendVerificationSchema = {
  body: Type.Object({
    phoneNumber: Type.String({ minLength: 1, pattern: '^\\+[1-9][0-9]{7,15}$' }),
  }),
  response: {
    200: Type.Object({
      success: Type.Boolean(),
      message: Type.String(),
      code: Type.Optional(Type.String()),
    }),
    400: Type.Object({
      error: Type.String(),
    }),
    500: Type.Object({
      error: Type.String(),
    }),
  },
};

const CheckVerificationSchema = {
  body: Type.Object({
    phoneNumber: Type.String({ minLength: 1, pattern: '^\\+[1-9][0-9]{7,15}$' }),
    code: Type.String({ minLength: 4, maxLength: 10 }),
  }),
  response: {
    200: Type.Object({
      success: Type.Boolean(),
      message: Type.String(),
      token: Type.String(),
      user: Type.Object({
        userId: Type.Number(),
        phoneNumber: Type.String(),
        name: Type.Union([Type.String(), Type.Null()]),
        email: Type.Union([Type.String(), Type.Null()]),
      }),
      newUser: Type.Boolean(),
    }),
    400: Type.Object({
      error: Type.String(),
    }),
    500: Type.Object({
      error: Type.String(),
    }),
  },
};

server.post(
  '/send-verification',
  {
    schema: SendVerificationSchema,
  },
  async (request, reply) => {
    const { phoneNumber } = request.body;

    try {
      const code = await twilioService.sendVerificationCode(phoneNumber);
      return {
        success: true,
        message: 'Verification code sent',
        // Only return the code in development (for testing)
        ...(process.env.NODE_ENV === 'development' && code && { code }),
      };
    } catch (error) {
      console.error('Error sending verification:', error);
      reply.code(500);
      return { error: 'Failed to send verification code' };
    }
  }
);

server.post(
  '/check-verification',
  {
    schema: CheckVerificationSchema,
  },
  async (request, reply) => {
    const { phoneNumber, code } = request.body;

    try {
      const result = await twilioService.checkVerificationCode(phoneNumber, code);

      if (result.status === 'ok') {
        // Generate token for the verified user
        const token = generatePhoneVerificationToken(
          result.record.phoneE164,
          result.record.userId,
          result.record.name || undefined,
          result.record.email || undefined
        );

        // Set cookie with the token
        reply.setCookie('phone_verification', token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
        });

        return {
          success: true,
          message: 'Verification successful',
          token,
          user: {
            userId: result.record.userId,
            phoneNumber: result.record.phoneE164,
            name: result.record.name,
            email: result.record.email,
          },
          newUser: result.newUser,
        };
      } else {
        reply.code(400);
        return { error: 'Invalid or expired verification code' };
      }
    } catch (error) {
      console.error('Error checking verification:', error);
      reply.code(500);
      return { error: 'Failed to verify code' };
    }
  }
);

// Availability routes schemas
const AvailableSlotsSchema = {
  querystring: Type.Object({
    start: Type.String({ format: 'date-time' }),
    stop: Type.String({ format: 'date-time' }),
  }),
  response: {
    200: Type.Object({
      success: Type.Boolean(),
      data: Type.Array(
        Type.Object({
          slot: Type.Object({
            start: Type.String({ format: 'date-time' }),
            end: Type.String({ format: 'date-time' }),
          }),
          unitId: Type.Number(),
          price: Type.Number(),
          signature: Type.String(),
        })
      ),
    }),
    401: Type.Object({
      error: Type.String(),
    }),
    500: Type.Object({
      error: Type.String(),
    }),
  },
};

const BookSlotSchema = {
  body: Type.Object({
    slot: Type.Object({
      start: Type.String({ format: 'date-time' }),
      end: Type.String({ format: 'date-time' }),
    }),
    unitId: Type.Number(),
    price: Type.Number(),
    signature: Type.String(),
  }),
  response: {
    200: Type.Object({
      success: Type.Boolean(),
      message: Type.String(),
      bookingId: Type.Number(),
    }),
    400: Type.Object({
      error: Type.String(),
    }),
    401: Type.Object({
      error: Type.String(),
    }),
    500: Type.Object({
      error: Type.String(),
    }),
  },
};

server.get(
  '/available-slots',
  {
    schema: AvailableSlotsSchema,
    preHandler: requirePermissions(['approved', 'trained']),
  },
  async (request, reply) => {
    try {
      const { start, stop } = request.query;
      const startDate = new Date(start);
      const stopDate = new Date(stop);

      // Validate date range
      if (startDate >= stopDate) {
        reply.code(400);
        return { error: 'Start date must be before stop date' };
      }

      // Limit to reasonable time ranges (e.g., max 30 days)
      const maxDays = 30;
      const daysDiff = (stopDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysDiff > maxDays) {
        reply.code(400);
        return { error: `Date range cannot exceed ${maxDays} days` };
      }

      const availability = await availabilityManager.availableSlots(startDate, stopDate);

      return {
        success: true,
        data: availability.data.map(slot => ({
          ...slot,
          slot: {
            start: slot.slot.start.toISOString(),
            end: slot.slot.end.toISOString(),
          },
        })),
      };
    } catch (error) {
      console.error('Error fetching available slots:', error);
      reply.code(500);
      return { error: 'Failed to fetch available slots' };
    }
  }
);

server.post(
  '/book-slot',
  {
    schema: BookSlotSchema,
    preHandler: requirePermissions(['approved', 'trained'])
  },
  async (request, reply) => {
    try {
      const { slot, unitId, price, signature } = request.body;

      // Create AvailableSlot object for verification
      const slotData = {
        slot: {
          start: new Date(slot.start),
          end: new Date(slot.end),
        },
        unitId,
        price,
        signature,
      };

      const userId = request.user!.userId;
      // Book the slot (verification happens inside bookSlot)
      const success = await availabilityManager.bookSlot(userId, slotData);

      if (success) {
        // Get the booking ID for response (you'd need to modify bookSlot to return it)
        return {
          success: true,
          message: 'Slot booked successfully',
          bookingId: 0, // TODO: Return actual booking ID
        };
      } else {
        reply.code(400);
        return { error: 'Failed to book slot' };
      }
    } catch (error) {
      console.error('Error booking slot:', error);

      if (error instanceof Error) {
        reply.code(400);
        return { error: error.message };
      }

      reply.code(500);
      return { error: 'Failed to book slot' };
    }
  }
);

// Application submission schema
const SubmitApplicationSchema = {
  body: Type.Object({
    name: Type.String({ minLength: 1, maxLength: 100 }),
    email: Type.String({ format: 'email', maxLength: 255 }),
    phone: Type.String({ pattern: '^\\+[1-9][0-9]{7,15}$' }),
    aboutBathing: Type.String({ minLength: 1, maxLength: 1000 }),
    intendedUsage: Type.String({ minLength: 1, maxLength: 500 }),
    reference1Name: Type.String({ minLength: 1, maxLength: 100 }),
    reference1Phone: Type.String({ pattern: '^\\+[1-9][0-9]{7,15}$' }),
    reference2Name: Type.String({ minLength: 1, maxLength: 100 }),
    reference2Phone: Type.String({ pattern: '^\\+[1-9][0-9]{7,15}$' }),
  }),
  response: {
    200: Type.Object({
      success: Type.Boolean(),
      message: Type.String(),
    }),
    400: Type.Object({
      error: Type.String(),
    }),
    500: Type.Object({
      error: Type.String(),
    }),
  },
};

server.post(
  '/submit-application',
  {
    schema: SubmitApplicationSchema,
  },
  async (request, reply) => {
    try {
      const {
        name,
        email,
        phone,
        aboutBathing,
        intendedUsage,
        reference1Name,
        reference1Phone,
        reference2Name,
        reference2Phone,
      } = request.body;

      // Check if application already exists for this phone/email
      const existingApplication = await db.query.applications.findFirst({
        where: sql`phone_e164 = ${phone} OR email = ${email}`,
      });

      if (existingApplication) {
        reply.code(400);
        return { error: 'An application already exists for this phone number or email address.' };
      }

      // Insert the application
      await db.insert(applications).values({
        name,
        email,
        phoneE164: phone,
        aboutBathing,
        intendedUsage,
        reference1Name,
        reference1Phone,
        reference2Name,
        reference2Phone,
        status: 'pending',
      });

      // Check if user account already exists with this phone number
      const existingUser = await db.query.users.findFirst({
        where: eq(users.phoneE164, phone),
      });

      if (existingUser) {
        // Update existing user account with application data
        await db.update(users)
          .set({
            name,
            email,
          })
          .where(eq(users.phoneE164, phone));
      } else {
        throw 'user does not exist';
      }

      return {
        success: true,
        message: 'Application submitted successfully. We will review it within 3-5 business days.',
      };
    } catch (error) {
      console.error('Error submitting application:', error);
      reply.code(500);
      return { error: 'Failed to submit application. Please try again.' };
    }
  }
);

// Application review schema
const ReviewApplicationSchema = {
  body: Type.Object({
    applicationId: Type.Number(),
    action: Type.Union([Type.Literal('approve'), Type.Literal('reject')]),
    reviewNotes: Type.Optional(Type.String({ maxLength: 1000 })),
  }),
  response: {
    200: Type.Object({
      success: Type.Boolean(),
      message: Type.String(),
    }),
    400: Type.Object({
      error: Type.String(),
    }),
    403: Type.Object({
      error: Type.String(),
    }),
    500: Type.Object({
      error: Type.String(),
    }),
  },
};

server.post(
  '/review-application',
  {
    schema: ReviewApplicationSchema,
    preHandler: requirePermissions(['applicationReviewer']),
  },
  async (request, reply) => {
    try {
      const { applicationId, action, reviewNotes } = request.body;
      const reviewerId = request.user!.userId;

      // Get the application
      const application = await db.query.applications.findFirst({
        where: eq(applications.applicationId, applicationId)
      });

      if (!application) {
        reply.code(400);
        return { error: 'Application not found' };
      }

      if (application.status !== 'pending') {
        reply.code(400);
        return { error: 'Application has already been reviewed' };
      }

      // Update application status
      const newStatus = action === 'approve' ? 'approved' : 'rejected';
      await db
        .update(applications)
        .set({
          status: newStatus,
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
          reviewNotes: reviewNotes || null,
        })
        .where(eq(applications.applicationId, applicationId));

      // If approved, also update the user's approved status
      if (action === 'approve') {
        await db
          .update(users)
          .set({ approved: true })
          .where(eq(users.phoneE164, application.phoneE164));
      }

      return {
        success: true,
        message: `Application ${action === 'approve' ? 'approved' : 'rejected'} successfully`,
      };
    } catch (error) {
      console.error('Error reviewing application:', error);
      reply.code(500);
      return { error: 'Failed to review application' };
    }
  }
);

// User bookings in range schema
const UserBookingsInRangeSchema = {
  querystring: Type.Object({
    start: Type.String({ format: 'date-time' }),
    stop: Type.String({ format: 'date-time' }),
  }),
  response: {
    200: Type.Object({
      success: Type.Boolean(),
      data: Type.Array(
        Type.Object({
          bookingId: Type.Number(),
          slot: Type.String(),
          status: Type.String(),
          unitId: Type.Number(),
        })
      ),
    }),
    401: Type.Object({
      error: Type.String(),
    }),
    500: Type.Object({
      error: Type.String(),
    }),
  },
};

server.get(
  '/user-bookings-in-range',
  {
    schema: UserBookingsInRangeSchema,
    preHandler: requirePermissions(['approved', 'trained']),
  },
  async (request, reply) => {
    const userId = request.user!.userId;
    try {
      const { start, stop } = request.query;
      const startDate = new Date(start);
      const stopDate = new Date(stop);
      
      const bookings = await availabilityManager.getUserBookingsInRange(userId, startDate, stopDate);
      
      return {
        success: true,
        data: bookings.map(booking => ({
          bookingId: booking.bookingId,
          slot: booking.slot,
          status: booking.status,
          unitId: booking.unitId,
        })),
      };
    } catch (error) {
      console.error('Error fetching user bookings:', error);
      reply.code(500);
      return { error: 'Failed to fetch bookings' };
    }
  }
);

// Stripe checkout session schema
const CreateCheckoutSessionSchema = {
  body: Type.Object({
    creditAmountCents: Type.Number({ minimum: 2000, maximum: 50000 }), // $5 to $500
    totalChargeCents: Type.Number({ minimum: 2000 }),
  }),
  response: {
    200: Type.Object({
      url: Type.String(),
    }),
    400: Type.Object({
      error: Type.String(),
    }),
    401: Type.Object({
      error: Type.String(),
    }),
    500: Type.Object({
      error: Type.String(),
    }),
  },
};

server.post(
  '/create-checkout-session',
  {
    schema: CreateCheckoutSessionSchema,
    preHandler: requirePermissions(['approved']),
  },
  async (request, reply) => {
    const userId = request.user!.userId;

    try {
      const { creditAmountCents, totalChargeCents } = request.body;

      // Create Stripe checkout session
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: `Account Credit - $${(creditAmountCents / 100).toFixed(2)}`,
                description: `Add $${(creditAmountCents / 100).toFixed(2)} to your account balance`,
              },
              unit_amount: totalChargeCents,
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: `http://${config.general.domain}/credits?success=true`,
        cancel_url: `http://${config.general.domain}/credits?cancelled=true`,
        metadata: {
          userId: userId.toString(),
          creditAmountCents: creditAmountCents.toString(),
        },
      });

      return { url: session.url! };
    } catch (error) {
      console.error('Error creating checkout session:', error);
      reply.code(500);
      return { error: 'Failed to create checkout session' };
    }
  }
);

// Stripe webhook for handling successful payments
server.post('/stripe-webhook', async (request, reply) => {
  const sig = request.headers['stripe-signature'] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    reply.code(400);
    return { error: 'Webhook secret not configured' };
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent((request as any).rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    reply.code(400);
    return { error: 'Invalid signature' };
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const { userId, creditAmountCents } = session.metadata!;

    try {
      // Insert credit transaction - the trigger will automatically update the balance
      await db.insert(creditTransactions).values({
        userId: parseInt(userId),
        amountCents: parseInt(creditAmountCents),
        currency: 'USD',
        kind: 'purchase',
        paymentId: session.payment_intent?.toString() || null,
        note: `Credit purchase via Stripe - $${(parseInt(creditAmountCents) / 100).toFixed(2)}`,
      });

      console.log(`Successfully processed credit purchase for user ${userId}: $${(parseInt(creditAmountCents) / 100).toFixed(2)}`);
    } catch (error) {
      console.error('Error processing successful payment:', error);
    }
  }

  return { received: true };
});

async function start() {
  try {
    // Initialize database and run migrations
    await initializeDatabase();

    // Start the server
    await server.listen({ port: 8080 });
    console.log(`Server listening at http://localhost:8080`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
