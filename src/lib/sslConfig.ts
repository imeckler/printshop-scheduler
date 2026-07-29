// Managed databases use certs we can't verify, so SSL is on with
// rejectUnauthorized: false by default. A URL with sslmode=disable (local
// docker Postgres has no SSL at all) turns it off entirely.
export function sslForUrl(url: string): false | { rejectUnauthorized: boolean } {
  return url.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
}
