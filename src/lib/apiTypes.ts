// Shared API types between server and client

// Phone verification types
export interface SendVerificationRequest {
  phoneNumber: string;
}

export interface SendVerificationResponse {
  success: boolean;
  message: string;
  code?: string; // Only in development
}

export interface SendVerificationErrorResponse {
  error: string;
}

export interface CheckVerificationRequest {
  phoneNumber: string;
  code: string;
}

export interface CheckVerificationResponse {
  success: boolean;
  message: string;
  token: string;
  user: {
    userId: number;
    phoneNumber: string;
    name: string | null;
    email: string | null;
  };
  newUser: boolean;
}

export interface CheckVerificationErrorResponse {
  error: string;
}

// Availability types
export interface AvailableSlotsQuery {
  start: string; // ISO date-time string
  stop: string; // ISO date-time string
}

export interface AvailableSlot {
  slot: {
    start: string; // ISO date-time string
    end: string; // ISO date-time string
  };
  unitId: number;
  price: number;
  signature: string;
}

export interface AvailableSlotsResponse {
  success: boolean;
  data: AvailableSlot[];
}

export interface AvailableSlotsErrorResponse {
  error: string;
}

// Booking types
export interface BookingDensityRequest {
  unitId: number,
  start: string,
  end: string,
}

export interface BookingDensityResponse {
  intervals: { startTime: string, endTime: string, bookedCount: number }[],
  totalCapacity: number,
  requestedRange: { start: number, end: number },
}

export interface BookCustomRangeRequest {
  unitId: number,
  start: string,
  end: string,
}

export interface BookSlotRequest {
  slot: {
    start: string; // ISO date-time string
    end: string; // ISO date-time string
  };
  unitId: number;
  price: number;
  signature: string;
}

export interface BookSlotResponse {
  success: boolean;
  message: string;
  bookingId: number;
}

export interface BookSlotErrorResponse {
  error: string;
}

// Union types for all possible responses
export type SendVerificationApiResponse = SendVerificationResponse | SendVerificationErrorResponse;
export type CheckVerificationApiResponse =
  | CheckVerificationResponse
  | CheckVerificationErrorResponse;
export type AvailableSlotsApiResponse = AvailableSlotsResponse | AvailableSlotsErrorResponse;
export type BookSlotApiResponse = BookSlotResponse | BookSlotErrorResponse;

// Type guards for response checking
export function isSuccessResponse<T extends { success: boolean }, E extends { error: string }>(
  response: T | E
): response is T {
  return 'success' in response && response.success === true;
}

export function isErrorResponse<T extends { success: boolean }, E extends { error: string }>(
  response: T | E
): response is E {
  return 'error' in response;
}
