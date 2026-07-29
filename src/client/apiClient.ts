import {
  SendVerificationRequest,
  SendVerificationApiResponse,
  CheckVerificationRequest,
  CheckVerificationApiResponse,
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

export { isSuccessResponse, isErrorResponse };
