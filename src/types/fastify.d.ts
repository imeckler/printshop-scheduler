// src/types/fastify.d.ts   ← any *.d.ts that is picked up by tsconfig
import 'fastify';
import { User } from '../lib/dbtypes';

declare module 'fastify' {
  // 👇️ new property you are about to add
  interface FastifyRequest {
    user: User | null;
  }
}

