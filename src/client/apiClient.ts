import {
  SendVerificationRequest,
  SendVerificationApiResponse,
  CheckVerificationRequest,
  CheckVerificationApiResponse,
  AvailableSlotsQuery,
  AvailableSlotsApiResponse,
  BookSlotRequest,
  BookSlotApiResponse,
  isSuccessResponse,
  isErrorResponse,
} from '../lib/apiTypes';

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(endpoint, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

export async function sendVerification(
  data: SendVerificationRequest
): Promise<SendVerificationApiResponse> {
  return request<SendVerificationApiResponse>('/send-verification', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function checkVerification(
  data: CheckVerificationRequest
): Promise<CheckVerificationApiResponse> {
  return request<CheckVerificationApiResponse>('/check-verification', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getAvailableSlots(
  query: AvailableSlotsQuery
): Promise<AvailableSlotsApiResponse> {
  const params = new URLSearchParams(query);
  return request<AvailableSlotsApiResponse>(`/available-slots?${params}`);
}

export async function bookSlot(data: BookSlotRequest): Promise<BookSlotApiResponse> {
  return request<BookSlotApiResponse>('/book-slot', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export { isSuccessResponse, isErrorResponse };
