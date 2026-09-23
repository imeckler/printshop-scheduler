// src/types/fastify.d.ts   ← any *.d.ts that is picked up by tsconfig
import 'fastify';
import { User } from '../lib/dbtypes';

declare module 'fastify' {
  // 👇️ new property you are about to add
  interface FastifyRequest {
    user: User | null;
    // Original filenames of multipart uploads, by field name (see the
    // @fastify/multipart onFile hook in index.ts).
    uploadFilenames?: Record<string, string>;
  }

  interface FastifyReply {
    // @fastify/view merges this into every template's data (the plugin is
    // registered via require, so its own typings aren't picked up).
    locals?: Record<string, unknown>;
  }
}
