import fastify from 'fastify';
import cookie from '@fastify/cookie';
import view from '@fastify/view';
import staticFiles from '@fastify/static';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import handlebars from 'handlebars';
import { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import path from 'path';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { initializeDatabase } from './lib/db';
import twilioService from './lib/twilio';
import {
  generateAdminToken,
  verifyAdminToken,
  generatePhoneVerificationToken,
  getVerifiedUserIdFromRequest,
} from './lib/tokenService';
import { User } from './lib/dbtypes';
import {
  setBroadcastFunction,
  createEvent,
  bookPrintshopSlot,
  activateLock,
  getActivatableSlot,
  cancelEvent,
  cancelOccurrence,
  addPermission,
  removePermission,
  getUserOccurrences,
  getUnitDensity,
  getActiveAccessWindows,
  startMaterializationTimer,
  buildRecurrence,
  describeSchedule,
  localDateTimeToInstant,
  DEFAULT_TIMEZONE,
} from './lib/events';
import { db } from './lib/db';
import {
  events,
  eventTimeslots,
  users,
  creditBalances,
  creditTransactions,
  applications,
  units,
  risographUsages,
  risoLastSeenTotals,
} from './lib/schema';
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
      details: error.validation,
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
    day: 'numeric',
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
    hour12: true,
  });

  const endFormatted = endDate.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
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
    hour12: true,
  });
});

handlebars.registerHelper('eq', function (a: any, b: any) {
  return a === b;
});

handlebars.registerHelper('gt', function (a: number, b: number) {
  return a > b;
});

handlebars.registerHelper('lt', function (a: number, b: number) {
  return a < b;
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

// Admin auth: the admin panel is password-based (ADMIN_PASSWORD -> signed
// admin_session cookie), separate from user JWTs.
function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const adminToken = request.cookies.admin_session;
  if (!adminToken || !verifyAdminToken(adminToken)) {
    reply.redirect('/admin?error=Please+log+in+as+admin');
    return false;
  }
  return true;
}

// shared auth function
function requirePermissions(
  perms: Array<{ [K in keyof User]: User[K] extends boolean ? K : never }[keyof User]>
) {
  return async function authorize(request: FastifyRequest, reply: FastifyReply) {
    const userId = getVerifiedUserIdFromRequest(request);
    if (!userId) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.userId, userId),
    });
    if (!user) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    request.user = user;

    const ok =
      (request.cookies?.admin_session && verifyAdminToken(request.cookies.admin_session)) ||
      perms.every(k => user[k]);
    if (!ok) return reply.code(403).send({ error: 'Forbidden' });
  };
}

// Initialize config and Stripe
const config = getConfig();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-07-30.basil',
});

// Site password gate
if (config.general.site_password) {
  const siteAccessToken = crypto
    .createHmac('sha256', config.jwt.secret)
    .update(config.general.site_password)
    .digest('hex');

  server.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0];
    if (
      url === '/gate' ||
      url.startsWith('/public/') ||
      url === '/ping' ||
      url === '/stripe-webhook' ||
      url === '/api/submit-usage-csv' ||
      url.startsWith('/ws/')
    ) {
      return;
    }
    if (request.cookies?.site_access === siteAccessToken) {
      return;
    }
    return reply.redirect('/gate');
  });

  server.get('/gate', async (request, reply) => {
    if (request.cookies?.site_access === siteAccessToken) {
      return reply.redirect('/');
    }
    const error = (request.query as any).error;
    const template = handlebars.compile(
      require('fs').readFileSync(path.join(__dirname, '..', 'views', 'gate.hbs'), 'utf-8')
    );
    return reply.type('text/html').send(
      template({
        siteName: config.general.site_name,
        error: !!error,
      })
    );
  });

  server.post('/gate', async (request, reply) => {
    const { password } = request.body as { password: string };
    if (password === config.general.site_password) {
      reply.setCookie('site_access', siteAccessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 365 * 24 * 60 * 60, // 1 year
        path: '/',
      });
      return reply.redirect('/');
    }
    return reply.redirect('/gate?error=1');
  });
}

server.get('/ping', async (request, reply) => {
  return 'pong\n';
});

server.get('/', async (request, reply) => {
  const userId = getVerifiedUserIdFromRequest(request);

  if (userId) {
    // Get user details to check approval status
    const user = await db.query.users.findFirst({
      where: eq(users.userId, userId),
    });

    if (!user) {
      reply.clearCookie('phone_verification');
      return reply.redirect('/login');
    }

    // If user is approved, show normal homepage
    if (user.approved) {
      const occurrences = await getUserOccurrences(userId);
      const activatable = await getActivatableSlot(userId);
      const { activated, error } = request.query as { activated?: string; error?: string };

      return reply.view('home', {
        user: { id: userId, name: user.name, code: user.code, printshop: user.printshop },
        occurrences: occurrences.map(o => ({
          ...o,
          cancellable: o.createdBy === userId,
        })),
        activatable,
        activationSuccess: activated === 'true',
        activationError: error,
      });
    }

    // If user is not approved, check their application status
    const application = await db.query.applications.findFirst({
      where: eq(applications.phoneE164, user.phoneE164),
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
          reviewNotes: application.reviewNotes,
        },
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
    success: success === 'true',
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
    error: error === 'invalid' ? 'Invalid password' : undefined,
  });
});

server.post('/admin/login', async (request, reply) => {
  const { password } = request.body as { password: string };

  const cookieOpts: CookieSerializeOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
    path: '/',
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
  if (!requireAdmin(request, reply)) return;

  try {
    // Get system statistics
    const stats = await Promise.all([
      db.query.users.findMany().then(users => users.length),
      db.query.applications
        .findMany({ where: eq(applications.status, 'pending') })
        .then(apps => apps.length),
      db.query.applications
        .findMany({ where: eq(applications.status, 'approved') })
        .then(apps => apps.length),
      db.query.applications
        .findMany({ where: eq(applications.status, 'rejected') })
        .then(apps => apps.length),
      db.query.events.findMany().then(events => events.length),
    ]);

    const [totalUsers, pendingApps, approvedApps, rejectedApps, totalBookings] = stats;

    // Get recent activity
    const recentApplications = await db.query.applications.findMany({
      orderBy: desc(applications.createdAt),
      limit: 10,
    });

    const recentUsers = await db.query.users.findMany({
      orderBy: desc(users.createdAt),
      limit: 10,
    });

    return reply.view('admin-dashboard', {
      stats: {
        totalUsers,
        pendingApps,
        approvedApps,
        rejectedApps,
        totalBookings,
      },
      recentApplications,
      recentUsers,
    });
  } catch (error) {
    console.error('Error loading admin dashboard:', error);
    return reply.view('admin-dashboard', {
      stats: { totalUsers: 0, pendingApps: 0, approvedApps: 0, rejectedApps: 0, totalBookings: 0 },
      recentApplications: [],
      recentUsers: [],
      error: 'Failed to load dashboard data',
    });
  }
});

server.post('/admin/logout', async (request, reply) => {
  reply.clearCookie('admin_session');
  return reply.redirect('/admin');
});

// Admin users management page
server.get('/admin/users', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  try {
    const allUsers = await db.query.users.findMany({
      orderBy: desc(users.createdAt),
    });

    const { success, error } = request.query as { success?: string; error?: string };

    return reply.view('admin-users', {
      users: allUsers,
      success,
      error,
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    return reply.redirect('/admin?error=Failed+to+load+users');
  }
});

// Update user permissions
server.post('/admin/users/:userId/update', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  try {
    const { userId } = request.params as { userId: string };
    const { approved, trained, printshop, eventCreator, risoUsername } = request.body as {
      approved?: string;
      trained?: string;
      printshop?: string;
      eventCreator?: string;
      risoUsername?: string;
    };

    await db
      .update(users)
      .set({
        approved: approved === 'on',
        trained: trained === 'on',
        printshop: printshop === 'on',
        eventCreator: eventCreator === 'on',
        risoUsername: risoUsername?.trim() || null,
      })
      .where(eq(users.userId, parseInt(userId)));

    return reply.redirect('/admin/users?success=User+updated+successfully');
  } catch (error) {
    console.error('Error updating user:', error);
    return reply.redirect('/admin/users?error=Failed+to+update+user');
  }
});

// Admin events management page. Printshop bookings (events with a unit) are
// hidden by default to keep the list readable; ?all=1 shows them.
server.get('/admin/events', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  try {
    const { success, error, all } = request.query as {
      success?: string;
      error?: string;
      all?: string;
    };

    const result = await db.execute(sql`
      SELECT e.event_id AS "eventId",
             e.name,
             e.kind,
             e.status,
             e.rrule,
             e.timezone,
             e.unit_id AS "unitId",
             e.created_at AS "createdAt",
             (SELECT count(*)::int FROM event_permissions p WHERE p.event_id = e.event_id) AS "userCount",
             (SELECT min(lower(ts.slot))
                FROM event_timeslots ts
               WHERE ts.event_id = e.event_id
                 AND ts.status = 'confirmed'
                 AND upper(ts.slot) > now()) AS "nextOccurrence"
      FROM events e
      ${all === '1' ? sql`` : sql`WHERE e.unit_id IS NULL`}
      ORDER BY e.created_at DESC
      LIMIT 200
    `);

    return reply.view('admin-events', {
      events: (result.rows as any[]).map(e => ({
        ...e,
        schedule: describeSchedule(e),
      })),
      showingAll: all === '1',
      success,
      error,
    });
  } catch (error) {
    console.error('Error fetching events:', error);
    return reply.redirect('/admin/dashboard');
  }
});

// Create an event from the admin form
server.post('/admin/events', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  const body = request.body as Record<string, string | string[] | undefined>;
  const asArray = (v: string | string[] | undefined): string[] =>
    v === undefined ? [] : Array.isArray(v) ? v : [v];

  try {
    const name = (body.name as string)?.trim();
    if (!name) {
      return reply.redirect('/admin/events?error=Event+name+is+required');
    }
    const description = (body.description as string)?.trim() || undefined;

    let created;
    if (body.scheduleType === 'recurring') {
      const { rrule, durationMinutes, timezone } = buildRecurrence({
        freq: body.freq === 'monthly' ? 'monthly' : 'weekly',
        interval: parseInt((body.interval as string) || '1', 10),
        weekday: parseInt(body.weekday as string, 10),
        monthlyMode: body.monthlyMode === 'last' ? 'last' : 'nth',
        nth: parseInt((body.nth as string) || '1', 10),
        startDate: body.startDate as string,
        startTime: body.startTime as string,
        endTime: body.endTime as string,
        ends: body.ends === 'until' ? 'until' : body.ends === 'count' ? 'count' : 'never',
        untilDate: body.untilDate as string | undefined,
        count: body.count ? parseInt(body.count as string, 10) : undefined,
      });

      created = await createEvent({
        name,
        description,
        kind: 'recurring',
        rrule,
        durationMinutes,
        timezone,
        permittedUserIds: [],
      });
    } else {
      const dates = asArray(body.slotDate);
      const starts = asArray(body.slotStart);
      const ends = asArray(body.slotEnd);
      const slots = dates
        .map((date, i) => ({ date, start: starts[i], end: ends[i] }))
        .filter(s => s.date && s.start && s.end)
        .map(s => ({
          start: localDateTimeToInstant(s.date, s.start, DEFAULT_TIMEZONE),
          end: localDateTimeToInstant(s.date, s.end, DEFAULT_TIMEZONE),
        }));

      created = await createEvent({
        name,
        description,
        kind: 'finite',
        slots,
        permittedUserIds: [],
      });
    }

    return reply.redirect(`/admin/events/${created.eventId}?success=Event+created`);
  } catch (error) {
    console.error('Error creating event:', error);
    const message = error instanceof Error ? error.message : 'Failed to create event';
    return reply.redirect(`/admin/events?error=${encodeURIComponent(message)}`);
  }
});

// Event detail: occurrences + permitted users
server.get('/admin/events/:id', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  const { id } = request.params as { id: string };
  const eventId = parseInt(id, 10);
  if (isNaN(eventId)) {
    return reply.redirect('/admin/events?error=Event+not+found');
  }

  try {
    const event = await db.query.events.findFirst({
      where: eq(events.eventId, eventId),
    });
    if (!event) {
      return reply.redirect('/admin/events?error=Event+not+found');
    }

    const occurrences = await db.execute(sql`
      SELECT ts.timeslot_id AS "timeslotId", ts.slot::text AS slot, ts.status
      FROM event_timeslots ts
      WHERE ts.event_id = ${eventId}
        AND upper(ts.slot) > now()
      ORDER BY lower(ts.slot)
      LIMIT 20
    `);

    const permittedUsers = await db.execute(sql`
      SELECT u.user_id AS "userId", u.name, u.phone_e164 AS "phoneE164"
      FROM event_permissions p
      JOIN users u ON u.user_id = p.user_id
      WHERE p.event_id = ${eventId}
      ORDER BY u.name NULLS LAST
    `);

    const allUsers = await db.query.users.findMany({
      orderBy: users.name,
      columns: { userId: true, name: true, phoneE164: true },
    });
    const permittedIds = new Set((permittedUsers.rows as any[]).map(u => Number(u.userId)));

    const { success, error } = request.query as { success?: string; error?: string };

    return reply.view('admin-event-detail', {
      event: {
        ...event,
        schedule: describeSchedule(event),
      },
      occurrences: occurrences.rows,
      permittedUsers: permittedUsers.rows,
      addableUsers: allUsers.filter(u => !permittedIds.has(u.userId)),
      success,
      error,
    });
  } catch (error) {
    console.error('Error fetching event:', error);
    return reply.redirect('/admin/events?error=Failed+to+load+event');
  }
});

server.post('/admin/events/:id/permissions/add', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  const { id } = request.params as { id: string };
  const eventId = parseInt(id, 10);
  const { userId } = request.body as { userId?: string };

  if (isNaN(eventId) || !userId) {
    return reply.redirect(`/admin/events/${id}?error=Invalid+request`);
  }

  try {
    await addPermission(eventId, parseInt(userId, 10));
    return reply.redirect(`/admin/events/${eventId}?success=User+added`);
  } catch (error) {
    console.error('Error adding permission:', error);
    return reply.redirect(`/admin/events/${eventId}?error=Failed+to+add+user`);
  }
});

server.post('/admin/events/:id/permissions/remove', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  const { id } = request.params as { id: string };
  const eventId = parseInt(id, 10);
  const { userId } = request.body as { userId?: string };

  if (isNaN(eventId) || !userId) {
    return reply.redirect(`/admin/events/${id}?error=Invalid+request`);
  }

  try {
    await removePermission(eventId, parseInt(userId, 10));
    return reply.redirect(`/admin/events/${eventId}?success=User+removed`);
  } catch (error) {
    console.error('Error removing permission:', error);
    return reply.redirect(`/admin/events/${eventId}?error=Failed+to+remove+user`);
  }
});

server.post('/admin/events/:id/cancel', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  const { id } = request.params as { id: string };
  const eventId = parseInt(id, 10);
  if (isNaN(eventId)) {
    return reply.redirect('/admin/events?error=Event+not+found');
  }

  try {
    const success = await cancelEvent(eventId);
    return success
      ? reply.redirect(`/admin/events?success=Event+cancelled`)
      : reply.redirect(`/admin/events/${eventId}?error=Event+is+not+active`);
  } catch (error) {
    console.error('Error cancelling event:', error);
    return reply.redirect(`/admin/events/${eventId}?error=Failed+to+cancel+event`);
  }
});

server.post('/admin/events/:id/occurrences/:tsId/cancel', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  const { id, tsId } = request.params as { id: string; tsId: string };
  const timeslotId = parseInt(tsId, 10);
  if (isNaN(timeslotId)) {
    return reply.redirect(`/admin/events/${id}?error=Occurrence+not+found`);
  }

  try {
    const success = await cancelOccurrence(timeslotId);
    return success
      ? reply.redirect(`/admin/events/${id}?success=Occurrence+cancelled`)
      : reply.redirect(`/admin/events/${id}?error=Occurrence+already+cancelled`);
  } catch (error) {
    console.error('Error cancelling occurrence:', error);
    return reply.redirect(`/admin/events/${id}?error=Failed+to+cancel+occurrence`);
  }
});

server.get(
  '/review-applications',
  { preHandler: requirePermissions(['applicationReviewer']) },
  async (request, reply) => {
    try {
      const pendingApplications = await db.query.applications.findMany({
        where: eq(applications.status, 'pending'),
        orderBy: applications.createdAt,
      });

      const recentReviewed = await db.query.applications.findMany({
        where: sql`status IN ('approved', 'rejected')`,
        orderBy: desc(applications.reviewedAt),
        limit: 20,
        with: {
          reviewer: {
            columns: {
              name: true,
              phoneE164: true,
            },
          },
        },
      });

      return reply.view('review-applications', {
        user: { id: request.user!.userId, name: request.user!.name },
        pendingApplications,
        recentReviewed,
      });
    } catch (error) {
      console.error('Error fetching applications:', error);
      return reply.view('review-applications', {
        user: { id: request.user!.userId, name: request.user!.name },
        pendingApplications: [],
        recentReviewed: [],
        error: 'Failed to load applications',
      });
    }
  }
);

// Activate the door lock: puts the user's code on the lock for the duration
// of a currently-running (or imminent) occurrence they're permissioned on.
server.post('/activate-lock', { preHandler: requirePermissions([]) }, async (request, reply) => {
  const userId = request.user!.userId;

  try {
    const result = await activateLock(userId);
    if (result.ok) {
      return reply.redirect('/?activated=true');
    }
    return reply.redirect(`/?error=${encodeURIComponent(result.error)}`);
  } catch (error) {
    console.error('Error activating lock:', error);
    return reply.redirect('/?error=Failed+to+activate+the+lock');
  }
});

server.get('/book', { preHandler: requirePermissions(['printshop']) }, async (request, reply) => {
  const userId = request.user!.userId;

  // Get user's credit balance
  const balance = await db.query.creditBalances.findFirst({
    where: eq(creditBalances.userId, userId),
  });

  return reply.view('booking', {
    user: { id: userId, name: request.user!.name },
    balance: balance?.balanceCents || 0,
  });
});

server.get(
  '/my-bookings',
  { preHandler: requirePermissions(['approved']) },
  async (request, reply) => {
    const userId = request.user!.userId;
    try {
      const occurrences = await getUserOccurrences(userId, { futureOnly: false });
      const now = new Date();
      const withCancellable = occurrences.map(o => ({
        ...o,
        cancellable: o.createdBy === userId,
      }));

      return reply.view('my-bookings', {
        user: { id: userId, name: request.user!.name },
        bookings: withCancellable.filter(o => o.slotRange.end > now),
        pastBookings: withCancellable.filter(o => o.slotRange.end <= now).reverse(),
      });
    } catch (error) {
      console.error('Error fetching user bookings:', error);
      return reply.view('my-bookings', {
        user: { id: userId, name: request.user!.name },
        bookings: [],
        pastBookings: [],
        error: 'Failed to load bookings',
      });
    }
  }
);

server.get('/credits', { preHandler: requirePermissions(['approved']) }, async (request, reply) => {
  const userId = request.user!.userId;

  try {
    // Get user's credit balance
    const balance = await db.query.creditBalances.findFirst({
      where: eq(creditBalances.userId, userId),
    });

    // Get recent credit transactions
    const transactions = await db.query.creditTransactions.findMany({
      where: eq(creditTransactions.userId, userId),
      orderBy: desc(creditTransactions.createdAt),
      limit: 20,
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
      pricing,
    });
  } catch (error) {
    console.error('Error fetching credit data:', error);
    return reply.view('credits', {
      user: { id: userId, name: request.user!.name },
      balance: 0,
      transactions: [],
      recentUsage: [],
      pricing: { copyPriceCents: 10, stencilPriceCents: 150 },
      error: 'Failed to load credit information',
    });
  }
});

// :id is an event_timeslots.timeslot_id. A user may cancel an occurrence only
// if they created the event (the printshop single-slot case), in which case
// the whole event is cancelled.
server.get(
  '/cancel-booking/:id',
  { preHandler: requirePermissions(['printshop']) },
  async (request, reply) => {
    const userId = request.user!.userId;
    const { id } = request.params as { id: string };
    const timeslotId = parseInt(id, 10);

    const timeslot = isNaN(timeslotId)
      ? undefined
      : await db.query.eventTimeslots.findFirst({
          where: eq(eventTimeslots.timeslotId, timeslotId),
          with: { event: true },
        });

    const cancellable =
      timeslot &&
      timeslot.status === 'confirmed' &&
      timeslot.event.status === 'active' &&
      timeslot.event.createdBy === userId;

    return reply.view('cancel-booking', {
      user: { id: userId, name: request.user!.name },
      booking: cancellable
        ? { timeslotId: timeslot.timeslotId, slot: timeslot.slot, eventName: timeslot.event.name }
        : undefined,
    });
  }
);

server.post(
  '/cancel-booking/:id',
  { preHandler: requirePermissions(['printshop']) },
  async (request, reply) => {
    const userId = request.user!.userId;
    const { id } = request.params as { id: string };
    const timeslotId = parseInt(id, 10);

    if (isNaN(timeslotId)) {
      return reply.redirect('/my-bookings');
    }

    try {
      const timeslot = await db.query.eventTimeslots.findFirst({
        where: eq(eventTimeslots.timeslotId, timeslotId),
      });
      if (!timeslot) {
        return reply.redirect('/my-bookings?error=cancel-failed');
      }

      const success = await cancelEvent(timeslot.eventId, { requireCreatorUserId: userId });

      if (success) {
        return reply.redirect('/my-bookings?cancelled=true');
      } else {
        return reply.redirect('/my-bookings?error=cancel-failed');
      }
    } catch (error) {
      console.error('Error cancelling booking:', error);
      return reply.redirect('/my-bookings?error=cancel-failed');
    }
  }
);

server.get('/logout', async (request, reply) => {
  reply.clearCookie('phone_verification');
  return reply.redirect('/');
});

const SendVerificationSchema = {
  body: Type.Object({
    phoneNumber: Type.String({ minLength: 1, pattern: '^\\+1[2-9][0-9]{9}$' }),
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
    phoneNumber: Type.String({ minLength: 1, pattern: '^\\+1[2-9][0-9]{9}$' }),
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

// Units endpoint to get all active units
server.get(
  '/api/units',
  {
    preHandler: requirePermissions(['printshop']),
  },
  async (request, reply) => {
    try {
      const activeUnits = await db.query.units.findMany({
        where: eq(units.active, true),
        orderBy: units.name,
      });

      return {
        success: true,
        data: activeUnits,
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
        end: Type.String(),
      }),
    },
    preHandler: requirePermissions(['printshop']),
  },
  async (request, reply) => {
    try {
      const { unitId, start, end } = request.query;
      const startDate = new Date(start);
      const endDate = new Date(end);

      const densityData = await getUnitDensity(unitId, startDate, endDate);

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
        end: Type.String(),
      }),
    },
    preHandler: requirePermissions(['printshop']),
  },
  async (request, reply) => {
    try {
      const { unitId, start, end } = request.body;
      const startDate = new Date(start);
      const endDate = new Date(end);
      const userId = request.user!.userId;

      // Check if user has sufficient balance (must not be negative)
      const balance = await db.query.creditBalances.findFirst({
        where: eq(creditBalances.userId, userId),
      });

      if (!balance || balance.balanceCents <= 0) {
        reply.code(402); // 402 Payment Required
        return {
          error: 'Insufficient credits. Please add credits to your account before booking.',
          balance: balance?.balanceCents ?? 0,
        };
      }

      await bookPrintshopSlot(userId, unitId, startDate, endDate);

      return {
        success: true,
        message: 'Custom time range booked successfully',
      };
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

// Create an event via JSON API. Gated on the event_creator user flag (the
// admin panel has its own form; this exists for permissioned users/tools).
server.post(
  '/api/events',
  {
    schema: {
      body: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 200 }),
        description: Type.Optional(Type.String({ maxLength: 2000 })),
        kind: Type.Union([Type.Literal('finite'), Type.Literal('recurring')]),
        slots: Type.Optional(
          Type.Array(
            Type.Object({
              start: Type.String({ format: 'date-time' }),
              end: Type.String({ format: 'date-time' }),
            }),
            { minItems: 1 }
          )
        ),
        rrule: Type.Optional(Type.String()),
        durationMinutes: Type.Optional(Type.Number({ minimum: 1 })),
        timezone: Type.Optional(Type.String()),
        permittedUserIds: Type.Optional(Type.Array(Type.Number())),
      }),
    },
    preHandler: requirePermissions(['eventCreator']),
  },
  async (request, reply) => {
    const userId = request.user!.userId;
    const { name, description, kind, slots, rrule, durationMinutes, timezone, permittedUserIds } =
      request.body;

    try {
      const created = await createEvent({
        name,
        description,
        createdBy: userId,
        kind,
        slots: slots?.map(s => ({ start: new Date(s.start), end: new Date(s.end) })),
        rrule,
        durationMinutes,
        timezone,
        // The creator is always permissioned on their own event
        permittedUserIds: Array.from(new Set([userId, ...(permittedUserIds ?? [])])),
      });

      return { success: true, eventId: created.eventId };
    } catch (error) {
      console.error('Error creating event:', error);
      reply.code(400);
      return { error: error instanceof Error ? error.message : 'Failed to create event' };
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
        await db
          .update(users)
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
        where: eq(applications.applicationId, applicationId),
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

// Stripe checkout session schema
const CreateCheckoutSessionSchema = {
  body: Type.Object({
    creditAmountCents: Type.Number({ minimum: 500, maximum: 50000 }), // $5 to $500
    totalChargeCents: Type.Number({ minimum: 500 }),
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
      resetsDetected: Type.Array(Type.String()),
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
  '/api/submit-usage-csv',
  {
    schema: SubmitUsageCsvSchema,
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

          const reportTimestamp = new Date(`${risoData.date} ${risoData.time}`);

          // Wrap entire read-compute-bill cycle in a transaction with row lock
          // to prevent double-billing from concurrent/duplicate CSV uploads
          await db.transaction(async tx => {
            // Lock the lastSeen row (SELECT FOR UPDATE) to serialize concurrent uploads
            const [lastSeen] = await tx
              .select()
              .from(risoLastSeenTotals)
              .where(eq(risoLastSeenTotals.userId, userId))
              .for('update');

            // Skip if we've already processed this or a newer report
            if (lastSeen?.lastReportDate && reportTimestamp <= lastSeen.lastReportDate) {
              console.log(
                `Skipping ${risoUser.userName}: report date ${reportTimestamp.toISOString()} <= last processed ${lastSeen.lastReportDate.toISOString()}`
              );
              return;
            }

            const lastSeenCopies = lastSeen?.lastSeenCopies || 0;
            const lastSeenStencils = lastSeen?.lastSeenStencils || 0;
            const cumulativeCopiesBilled = lastSeen?.cumulativeCopiesBilled || 0;
            const cumulativeStencilsBilled = lastSeen?.cumulativeStencilsBilled || 0;

            let copiesToBill = 0;
            let stencilsToBill = 0;

            // Check for counter reset
            if (risoUser.totalCopies < lastSeenCopies || risoUser.masterCount < lastSeenStencils) {
              // RESET DETECTED!
              resetsDetected.push(
                `${risoUser.userName}: copies ${lastSeenCopies} → ${risoUser.totalCopies}, stencils ${lastSeenStencils} → ${risoUser.masterCount}`
              );

              // Bill for unbilled pre-reset usage
              const preResetUnbilledCopies = Math.max(0, lastSeenCopies - cumulativeCopiesBilled);
              const preResetUnbilledStencils = Math.max(
                0,
                lastSeenStencils - cumulativeStencilsBilled
              );

              // Bill for post-reset usage (current totals)
              copiesToBill = preResetUnbilledCopies + risoUser.totalCopies;
              stencilsToBill = preResetUnbilledStencils + risoUser.masterCount;

              console.log(
                `Reset detected for ${risoUser.userName}: billing ${preResetUnbilledCopies} pre-reset + ${risoUser.totalCopies} post-reset copies`
              );
            } else {
              // Normal case: counter increased
              const incrementalCopies = risoUser.totalCopies - lastSeenCopies;
              const incrementalStencils = risoUser.masterCount - lastSeenStencils;

              copiesToBill = incrementalCopies;
              stencilsToBill = incrementalStencils;
            }

            // Only process if there's something to bill
            if (copiesToBill > 0 || stencilsToBill > 0) {
              const newCumulativeCopies = (lastSeen ? cumulativeCopiesBilled : 0) + copiesToBill;
              const newCumulativeStencils =
                (lastSeen ? cumulativeStencilsBilled : 0) + stencilsToBill;

              // Insert usage record
              await tx.insert(risographUsages).values({
                userId,
                copiesPrinted: copiesToBill,
                stencilsCreated: stencilsToBill,
                timestamp: reportTimestamp,
                rawData: `Model: ${risoData.model}, Serial: ${risoData.serial}, User: ${risoUser.userName}`,
              });

              // Create billing transaction
              await billingService.createUsageTransaction(userId, copiesToBill, stencilsToBill, tx);

              // Update last seen totals and cumulative billed
              if (lastSeen) {
                await tx
                  .update(risoLastSeenTotals)
                  .set({
                    lastSeenCopies: risoUser.totalCopies,
                    lastSeenStencils: risoUser.masterCount,
                    cumulativeCopiesBilled: newCumulativeCopies,
                    cumulativeStencilsBilled: newCumulativeStencils,
                    lastReportDate: reportTimestamp,
                    updatedAt: new Date(),
                  })
                  .where(eq(risoLastSeenTotals.userId, userId));
              } else {
                await tx.insert(risoLastSeenTotals).values({
                  userId,
                  lastSeenCopies: risoUser.totalCopies,
                  lastSeenStencils: risoUser.masterCount,
                  cumulativeCopiesBilled: newCumulativeCopies,
                  cumulativeStencilsBilled: newCumulativeStencils,
                  lastReportDate: reportTimestamp,
                  updatedAt: new Date(),
                });
              }

              console.log(
                `Billed ${risoUser.userName}: ${copiesToBill} copies, ${stencilsToBill} stencils`
              );
            } else {
              // No billing, but still update last seen totals
              if (lastSeen) {
                await tx
                  .update(risoLastSeenTotals)
                  .set({
                    lastSeenCopies: risoUser.totalCopies,
                    lastSeenStencils: risoUser.masterCount,
                    lastReportDate: reportTimestamp,
                    updatedAt: new Date(),
                  })
                  .where(eq(risoLastSeenTotals.userId, userId));
              } else {
                await tx.insert(risoLastSeenTotals).values({
                  userId,
                  lastSeenCopies: risoUser.totalCopies,
                  lastSeenStencils: risoUser.masterCount,
                  cumulativeCopiesBilled: 0,
                  cumulativeStencilsBilled: 0,
                  lastReportDate: reportTimestamp,
                  updatedAt: new Date(),
                });
              }
            }
          });

          processed++;
        } catch (error) {
          console.error(`Error processing usage for ${risoUser.userName}:`, error);
          errors.push(
            `Error processing ${risoUser.userName}: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      return {
        success: true,
        message: `Processed ${processed} user records from RISO report dated ${risoData.date} ${risoData.time}`,
        processed,
        errors,
        resetsDetected,
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

      console.log(
        `Successfully processed credit purchase for user ${userId}: $${(parseInt(creditAmountCents) / 100).toFixed(2)}`
      );
    } catch (error) {
      console.error('Error processing successful payment:', error);
    }
  }

  return { received: true };
});

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

// Replay currently-activated access windows to a (re)connecting daemon. The
// stored timestamps are resent verbatim: the daemon dedupes identical
// (code, start, stop) intervals and removes only by exact match.
async function sendExistingSlots(socket: WebSocket) {
  try {
    const windows = await getActiveAccessWindows();
    for (const window of windows) {
      const message: BookingMessage = {
        kind: 'addAccess',
        code: window.code,
        start: window.start,
        stop: window.stop,
      };
      socket.send(JSON.stringify(message));
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

// Connect the broadcast function to the events module
setBroadcastFunction(broadcastBookingMessage);

async function start() {
  try {
    // Initialize database and run migrations
    await initializeDatabase();

    // Materialize recurring events now and daily thereafter
    startMaterializationTimer();

    // Start the server (PORT env overrides for local testing; deploys use 3000)
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
    await server.listen({ host: '0.0.0.0', port });
    console.log(`Server listening at http://localhost:${port}`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
