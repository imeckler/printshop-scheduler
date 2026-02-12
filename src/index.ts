import fastify from 'fastify';
import cookie from '@fastify/cookie';
import view from '@fastify/view';
import staticFiles from '@fastify/static';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import handlebars from 'handlebars';
import { FastifyRequest, FastifyReply } from 'fastify';
import path from 'path';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { initializeDatabase } from './lib/db';
import twilioService from './lib/twilio';
import { generateAdminToken, verifyAdminToken, generatePhoneVerificationToken, getVerifiedUserIdFromRequest } from './lib/tokenService';
import { User } from './lib/dbtypes';
import { AvailabilityManager, setBroadcastFunction } from './lib/availability';
import { db } from './lib/db';
import { bookings, users, creditBalances, creditTransactions, creditPackages, applications, units, risographUsages, risoLastSeenTotals } from './lib/schema';
import { eq, desc, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { getConfig } from './lib/config';
import { CookieSerializeOptions } from '@fastify/cookie';
import { BookingMessage } from './lib/websocketTypes';

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

// Register WebSocket plugin
server.register(websocket);

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
handlebars.registerHelper('formatCurrency', function (cents: number) {
  return (cents / 100).toFixed(2);
});

handlebars.registerHelper('formatDate', function (date: Date) {
  console.log('eyo', date);
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
});

handlebars.registerHelper('formatSlot', function (slotRange: string) {
  // Parse slot range like '["2025-07-25 21:30:00+00","2025-07-25 22:00:00+00")'
  const match = slotRange.match(/^\["([^"]+)","([^"]+)"\)$/);
  if (!match) return slotRange; // Return original if parsing fails

  const startDate = new Date(match[1]);
  const endDate = new Date(match[2]);

  const startFormatted = startDate.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const endFormatted = endDate.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  return `${startFormatted} - ${endFormatted}`;
});
handlebars.registerHelper('formatDateTime', function (date: Date) {
  return new Date(date).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
});

handlebars.registerHelper('eq', function (a: any, b: any) {
  return a === b;
});

handlebars.registerHelper('gt', function (a: number, b: number) {
  return a > b;
});

handlebars.registerHelper('subtract', function (a: number, b: number) {
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
const availabilityManager = new AvailabilityManager();

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
  apiVersion: '2025-07-30.basil',
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

    // If user is approved, show normal homepage
    const bookings = await availabilityManager.getUserBookings(userId);
    const now = new Date();
    const upcomingBookings = bookings.filter(booking => {
      // Parse the slot properly: ["2025-09-17 07:15:00+00","2025-09-17 07:30:00+00")
      const slotMatch = booking.slot.match(/^\["([^"]+)","([^"]+)"\)$/);
      if (!slotMatch) return false;
      const endTime = new Date(slotMatch[2]);
      console.log('comparing', endTime, 'vs', now, '=', endTime > now);
      return endTime > now;
    });
    console.log(upcomingBookings);
    if (user.approved) {
      return reply.view('home', {
        user: { id: userId, name: user.name, code: user.code },
        upcomingBookings,
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

// Admin users management page
server.get('/admin/users', async (request, reply) => {
  // Check if admin is logged in
  const adminToken = request.cookies.admin_session;
  if (!adminToken || !verifyAdminToken(adminToken)) {
    return reply.redirect('/admin?error=Please+log+in+as+admin');
  }

  try {
    const allUsers = await db.query.users.findMany({
      orderBy: desc(users.createdAt)
    });

    const { success, error } = request.query as { success?: string; error?: string };

    return reply.view('admin-users', {
      users: allUsers,
      success,
      error
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    return reply.redirect('/admin?error=Failed+to+load+users');
  }
});

// Update user permissions
server.post('/admin/users/:userId/update', async (request, reply) => {
  // Check if admin is logged in
  const adminToken = request.cookies.admin_session;
  if (!adminToken || !verifyAdminToken(adminToken)) {
    return reply.redirect('/admin?error=Please+log+in+as+admin');
  }

  try {
    const { userId } = request.params as { userId: string };
    const { approved, trained } = request.body as { approved?: string; trained?: string };

    await db
      .update(users)
      .set({
        approved: approved === 'on',
        trained: trained === 'on'
      })
      .where(eq(users.userId, parseInt(userId)));

    return reply.redirect('/admin/users?success=User+updated+successfully');
  } catch (error) {
    console.error('Error updating user:', error);
    return reply.redirect('/admin/users?error=Failed+to+update+user');
  }
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
  const userId = request.user!.userId;

  // Get user's credit balance
  const balance = await db.query.creditBalances.findFirst({
    where: eq(creditBalances.userId, userId)
  });

  return reply.view('booking', {
    user: { id: userId, name: request.user!.name },
    balance: balance?.balanceCents || 0
  });
});

server.get('/my-bookings', { preHandler: requirePermissions(['approved']) }, async (request, reply) => {
  const userId = request.user!.userId;
  try {
    const bookings = await availabilityManager.getUserBookings(userId);

    // Separate upcoming and past bookings
    const now = new Date();
    const upcomingBookings = bookings.filter(booking => {
      const slotMatch = booking.slot.match(/^\["([^"]+)","([^"]+)"\)$/);
      if (!slotMatch) return false;
      return new Date(slotMatch[2]) > now;
    });
    const pastBookings = bookings.filter(booking => {
      const slotMatch = booking.slot.match(/^\["([^"]+)","([^"]+)"\)$/);
      if (!slotMatch) return false;
      return new Date(slotMatch[2]) <= now;
    });

    return reply.view('my-bookings', {
      user: { id: userId, name: request.user!.name },
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

    // Get recent usage data
    const { getBillingService } = await import('./lib/billingService');
    const billingService = getBillingService();
    const recentUsage = await billingService.getRecentUsageForUser(userId, 10);
    const pricing = billingService.getPricing();

    return reply.view('credits', {
      user: { id: userId, name: request.user!.name },
      balance: balance?.balanceCents || 0,
      transactions,
      recentUsage,
      pricing
    });
  } catch (error) {
    console.error('Error fetching credit data:', error);
    return reply.view('credits', {
      user: { id: userId, name: request.user!.name },
      balance: 0,
      transactions: [],
      recentUsage: [],
      pricing: { copyPriceCents: 10, stencilPriceCents: 150 },
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
    402: Type.Object({
      error: Type.String(),
      balance: Type.Number(),
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
        reply.code(500);
        return { error: 'Start date must be before stop date' };
      }

      // Limit to reasonable time ranges (e.g., max 30 days)
      const maxDays = 30;
      const daysDiff = (stopDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysDiff > maxDays) {
        reply.code(500);
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

      // Check if user has sufficient balance (must not be negative)
      const balance = await db.query.creditBalances.findFirst({
        where: eq(creditBalances.userId, userId)
      });

      if (balance && balance.balanceCents < 0) {
        reply.code(402); // 402 Payment Required
        return {
          error: 'Insufficient credits. Your balance is negative. Please add credits to your account before booking.',
          balance: balance.balanceCents
        };
      }

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

// Units endpoint to get all active units
server.get(
  '/api/units',
  {
    preHandler: requirePermissions(['approved', 'trained'])
  },
  async (request, reply) => {
    try {
      const activeUnits = await db.query.units.findMany({
        where: eq(units.active, true),
        orderBy: units.name
      });

      return {
        success: true,
        data: activeUnits
      };
    } catch (error) {
      console.error('Error fetching units:', error);
      reply.code(500);
      return { error: 'Failed to fetch units' };
    }
  }
);

// Booking density endpoint
server.get(
  '/api/booking-density',
  {
    schema: {
      querystring: Type.Object({
        unitId: Type.Number(),
        start: Type.String(),
        end: Type.String()
      })
    },
    preHandler: requirePermissions(['approved', 'trained'])
  },
  async (request, reply) => {
    try {
      const { unitId, start, end } = request.query;
      const startDate = new Date(start);
      const endDate = new Date(end);

      const densityData = await availabilityManager.getBookingDensity(unitId, startDate, endDate);

      return densityData;
    } catch (error) {
      console.error('Error fetching booking density:', error);
      reply.code(500);
      return { error: 'Failed to fetch booking density' };
    }
  }
);

// Book custom time range endpoint
server.post(
  '/api/book-custom-range',
  {
    schema: {
      body: Type.Object({
        unitId: Type.Number(),
        start: Type.String(),
        end: Type.String()
      })
    },
    preHandler: requirePermissions(['approved', 'trained'])
  },
  async (request, reply) => {
    try {
      const { unitId, start, end } = request.body;
      const startDate = new Date(start);
      const endDate = new Date(end);
      const userId = request.user!.userId;

      // Check if user has sufficient balance (must not be negative)
      const balance = await db.query.creditBalances.findFirst({
        where: eq(creditBalances.userId, userId)
      });

      if (balance && balance.balanceCents < 0) {
        reply.code(402); // 402 Payment Required
        return {
          error: 'Insufficient credits. Your balance is negative. Please add credits to your account before booking.',
          balance: balance.balanceCents
        };
      }

      console.log('boooook',
        startDate, endDate);
      const success = await availabilityManager.bookCustomTimeRange(userId, startDate, endDate, unitId);

      if (success) {
        return {
          success: true,
          message: 'Custom time range booked successfully'
        };
      } else {
        reply.code(400);
        return { error: 'Failed to book custom time range' };
      }
    } catch (error) {
      console.error('Error booking custom range:', error);

      if (error instanceof Error) {
        reply.code(400);
        return { error: error.message };
      }

      reply.code(500);
      return { error: 'Failed to book custom time range' };
    }
  }
);

// Application submission schema
const SubmitApplicationSchema = {
  body: Type.Object({
    name: Type.String({ minLength: 1, maxLength: 100 }),
    email: Type.String({ format: 'email', maxLength: 255 }),
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
    preHandler: requirePermissions([]),
  },
  async (request, reply) => {
    try {
      const {
        name,
        email,
        intendedUsage,
        reference1Name,
        reference1Phone,
        reference2Name,
        reference2Phone,
      } = request.body;

      if (!request.user) {
        reply.code(500);
        return { error: 'User not logged in' };
      }

      const phone = request.user.phoneE164;

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

// Usage data submission endpoint - accepts RISO CSV format
const SubmitUsageCsvSchema = {
  body: Type.Object({
    secret: Type.String(),
    csvData: Type.String(), // RISO CSV report content
  }),
  response: {
    200: Type.Object({
      success: Type.Boolean(),
      message: Type.String(),
      processed: Type.Number(),
      errors: Type.Array(Type.String()),
      resetsDetected: Type.Array(Type.String())
    }),
    401: Type.Object({
      error: Type.String()
    }),
    500: Type.Object({
      error: Type.String()
    })
  }
};

server.post(
  '/api/submit-usage-csv',
  {
    schema: SubmitUsageCsvSchema
  },
  async (request, reply) => {
    const { secret, csvData } = request.body;

    // Verify daemon secret
    const daemonSecret = process.env.DAEMON_SECRET || config.general?.daemon_secret;
    if (!daemonSecret || secret !== daemonSecret) {
      reply.code(401);
      return { error: 'Invalid or missing daemon secret' };
    }

    try {
      // Parse RISO CSV
      const { parseRisoCsv } = await import('./lib/risoCsvParser');
      const risoData = parseRisoCsv(csvData);

      const { getBillingService, mapRisoUserToDbUser } = await import('./lib/billingService');
      const billingService = getBillingService();

      let processed = 0;
      const errors: string[] = [];
      const resetsDetected: string[] = [];

      // Process each user in the CSV
      for (const risoUser of risoData.users) {
        try {
          // Map RISO username to database user ID
          const userId = await mapRisoUserToDbUser(risoUser.userName);

          if (!userId) {
            errors.push(`User not found: ${risoUser.userName}`);
            continue;
          }

          // Get last seen totals for this user
          const lastSeen = await db.query.risoLastSeenTotals.findFirst({
            where: eq(risoLastSeenTotals.userId, userId)
          });

          const lastSeenCopies = lastSeen?.lastSeenCopies || 0;
          const lastSeenStencils = lastSeen?.lastSeenStencils || 0;
          const cumulativeCopiesBilled = lastSeen?.cumulativeCopiesBilled || 0;
          const cumulativeStencilsBilled = lastSeen?.cumulativeStencilsBilled || 0;

          let copiesToBill = 0;
          let stencilsToBill = 0;

          // Check for counter reset
          if (risoUser.totalCopies < lastSeenCopies || risoUser.masterCount < lastSeenStencils) {
            // RESET DETECTED!
            resetsDetected.push(`${risoUser.userName}: copies ${lastSeenCopies} → ${risoUser.totalCopies}, stencils ${lastSeenStencils} → ${risoUser.masterCount}`);

            // Bill for unbilled pre-reset usage
            const preResetUnbilledCopies = Math.max(0, lastSeenCopies - cumulativeCopiesBilled);
            const preResetUnbilledStencils = Math.max(0, lastSeenStencils - cumulativeStencilsBilled);

            // Bill for post-reset usage (current totals)
            copiesToBill = preResetUnbilledCopies + risoUser.totalCopies;
            stencilsToBill = preResetUnbilledStencils + risoUser.masterCount;

            console.log(`Reset detected for ${risoUser.userName}: billing ${preResetUnbilledCopies} pre-reset + ${risoUser.totalCopies} post-reset copies`);
          } else {
            // Normal case: counter increased
            const incrementalCopies = risoUser.totalCopies - lastSeenCopies;
            const incrementalStencils = risoUser.masterCount - lastSeenStencils;

            copiesToBill = incrementalCopies;
            stencilsToBill = incrementalStencils;
          }

          // Only process if there's something to bill
          if (copiesToBill > 0 || stencilsToBill > 0) {
            // Insert usage record
            await db.insert(risographUsages).values({
              userId,
              copiesPrinted: copiesToBill,
              stencilsCreated: stencilsToBill,
              timestamp: new Date(`${risoData.date} ${risoData.time}`),
              rawData: `Model: ${risoData.model}, Serial: ${risoData.serial}, User: ${risoUser.userName}`
            });

            // Create billing transaction
            await billingService.createUsageTransaction(
              userId,
              copiesToBill,
              stencilsToBill
            );

            console.log(`Billed ${risoUser.userName}: ${copiesToBill} copies, ${stencilsToBill} stencils`);
          }

          // Update last seen totals and cumulative billed
          const newCumulativeCopies = (lastSeen ? cumulativeCopiesBilled : 0) + copiesToBill;
          const newCumulativeStencils = (lastSeen ? cumulativeStencilsBilled : 0) + stencilsToBill;

          if (lastSeen) {
            await db.update(risoLastSeenTotals)
              .set({
                lastSeenCopies: risoUser.totalCopies,
                lastSeenStencils: risoUser.masterCount,
                cumulativeCopiesBilled: newCumulativeCopies,
                cumulativeStencilsBilled: newCumulativeStencils,
                lastReportDate: new Date(`${risoData.date} ${risoData.time}`),
                updatedAt: new Date()
              })
              .where(eq(risoLastSeenTotals.userId, userId));
          } else {
            await db.insert(risoLastSeenTotals).values({
              userId,
              lastSeenCopies: risoUser.totalCopies,
              lastSeenStencils: risoUser.masterCount,
              cumulativeCopiesBilled: newCumulativeCopies,
              cumulativeStencilsBilled: newCumulativeStencils,
              lastReportDate: new Date(`${risoData.date} ${risoData.time}`),
              updatedAt: new Date()
            });
          }

          processed++;
        } catch (error) {
          console.error(`Error processing usage for ${risoUser.userName}:`, error);
          errors.push(`Error processing ${risoUser.userName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      return {
        success: true,
        message: `Processed ${processed} user records from RISO report dated ${risoData.date} ${risoData.time}`,
        processed,
        errors,
        resetsDetected
      };
    } catch (error) {
      console.error('Error processing RISO CSV:', error);
      reply.code(500);
      return { error: error instanceof Error ? error.message : 'Failed to process CSV' };
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

// Helper function to parse slot range
function parseSlot(slot: string): { start: Date; end: Date } | null {
  const match = slot.match(/^\["([^"]+)","([^"]+)"\)$/);
  if (!match) return null;

  return {
    start: new Date(match[1]),
    end: new Date(match[2])
  };
}

// Global set to store active WebSocket connections
const wsConnections = new Set<WebSocket>();

// WebSocket endpoint for booking messages
server.register(async function (fastify) {
  fastify.get('/ws/bookings', { websocket: true }, (socket: WebSocket, req) => {
    // Add connection to the set
    wsConnections.add(socket);

    // Send all existing future slots on initial connection
    sendExistingSlots(socket);

    // Remove connection from set on close
    socket.onclose = () => {
      wsConnections.delete(socket);
    };
  });
});

// Function to send existing future slots to a new connection
async function sendExistingSlots(socket: WebSocket) {
  try {
    // Get all future bookings from database using SQL query
    const futureBookings = await db.query.bookings.findMany({
      where: sql`upper(slot) > NOW()`,
      with: {
        user: {
          columns: {
            code: true
          }
        }
      }
    });

    // Send addAccess message for each future booking
    for (const booking of futureBookings) {
      const slotData = parseSlot(booking.slot);
      if (slotData && booking.user?.code) {
        const message: BookingMessage = {
          kind: 'addAccess',
          code: booking.user.code,
          start: slotData.start.getTime(),
          stop: slotData.end.getTime()
        };

        socket.send(JSON.stringify(message));
      }
    }
  } catch (error) {
    console.error('Error sending existing slots:', error);
  }
}

// Function to broadcast booking messages to all connected clients
function broadcastBookingMessage(message: BookingMessage) {
  const messageStr = JSON.stringify(message);
  wsConnections.forEach(socket => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(messageStr);
    }
  });
}

// Connect the broadcast function to availability manager
setBroadcastFunction(broadcastBookingMessage);

async function start() {
  try {
    // Initialize database and run migrations
    await initializeDatabase();


    // Start the server
    await server.listen({ host: '0.0.0.0', port: 3000 });
    console.log(`Server listening at http://localhost:3000`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
