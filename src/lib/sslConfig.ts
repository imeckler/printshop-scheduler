import { PoolConfig } from 'pg';

// Managed databases use certs we can't verify, so SSL is on with
// rejectUnauthorized: false by default; sslmode=disable in the URL (local
// docker Postgres has no SSL at all) turns SSL off entirely.
//
// The sslmode parameter is STRIPPED from the URL before it reaches pg:
// pg merges the parsed connection string OVER the explicit config
// (connection-parameters.js), so a URL sslmode like `require` would clobber
// our `rejectUnauthorized: false` with `ssl: {}` and re-enable certificate
// verification — which is exactly the SELF_SIGNED_CERT_IN_CHAIN boot failure
// this module exists to prevent.
export function pgPoolConfig(url: string): PoolConfig {
  let sslmode: string | null = null;
  let cleaned = url;
  try {
    const parsed = new URL(url);
    sslmode = parsed.searchParams.get('sslmode');
    parsed.searchParams.delete('sslmode');
    cleaned = parsed.toString();
  } catch {
    // Not URL-parseable (e.g. unix socket path): pass through untouched.
  }

  return {
    connectionString: cleaned,
    ssl: sslmode === 'disable' ? false : { rejectUnauthorized: false },
  };
}
