import fastify from 'fastify';
import cookie from '@fastify/cookie';
import view from '@fastify/view';
import staticFiles from '@fastify/static';
import handlebars from 'handlebars';
import path from 'path';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { initializeDatabase } from './lib/db';
import twilioService from './lib/twilio';
import { generatePhoneVerificationToken, getVerifiedUserIdFromRequest } from './lib/tokenService';
import { SaunaAvailabilityManager } from './lib/availability';

const server = fastify().withTypeProvider<TypeBoxTypeProvider>();

// Register cookie plugin
server.register(cookie);

// Register static files
server.register(staticFiles, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/public/',
});

// Register view engine
server.register(view, {
  engine: {
    handlebars: handlebars,
  },
  root: path.join(__dirname, '..', 'views'),
  layout: './layouts/main',
  options: {
    partials: {
      header: './partials/header',
      footer: './partials/footer',
    },
  },
});

// Initialize availability manager
const availabilityManager = new SaunaAvailabilityManager();

server.get('/ping', async (request, reply) => {
  return 'pong\n';
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
  },
  async (request, reply) => {
    const userId = getVerifiedUserIdFromRequest(request);

    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

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
  },
  async (request, reply) => {
    const userId = getVerifiedUserIdFromRequest(request);

    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

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
