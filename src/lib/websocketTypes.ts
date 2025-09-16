// Type definitions for booking messages
export type BookingMessage = 
  | { kind: 'addAccess', code: string, start: number, stop: number }
  | { kind: 'removeAccess', code: string, start: number, stop: number };