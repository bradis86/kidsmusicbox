import type { SessionInfo, PersonalState } from '../shared/types';
import { audioClientId } from './audioIdentity';
const csrf: Record<string, string> = {};
let childContext:
  Pick<PersonalState, 'profile' | 'revision' | 'deviceId'> | undefined;
export function setChildContext(personal: PersonalState | undefined) {
  childContext = personal;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const role =
    path.includes('/admin') || path.includes('/auth') ? 'parent' : 'child';
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: {
        ...(options.body && !(options.body instanceof Blob)
          ? { 'Content-Type': 'application/json' }
          : {}),
        'X-CSRF-Token': csrf[role] ?? '',
        ...(role === 'child' && childContext
          ? {
              'X-Child-Profile': childContext.profile.id,
              'X-Child-Device': childContext.deviceId,
              'X-Profile-Revision': String(childContext.revision),
            }
          : {}),
        ...(path === '/api/child/playback'
          ? { 'X-Audio-Client-Id': audioClientId() }
          : {}),
        ...options.headers,
      },
      signal:
        options.signal ??
        AbortSignal.timeout(
          path.endsWith('/playback') || path.endsWith('/audio/register')
            ? 45_000
            : 12000,
        ),
    });
  } catch (error) {
    throw new ApiError(
      error instanceof DOMException && error.name === 'TimeoutError'
        ? 'The request timed out. Please try again.'
        : 'Cannot reach the music hub. Check the connection and try again.',
      0,
    );
  }
  const body = await response
    .json()
    .catch(() => ({ error: 'Server returned an unexpected response' }));
  if (!response.ok)
    throw new ApiError(
      body.details?.join(' · ') || body.error || 'Request failed',
      response.status,
    );
  return body as T;
}
export const send = <T>(path: string, body: unknown, method = 'POST') =>
  api<T>(path, { method, body: JSON.stringify(body) });
export function setSession(role: string, session: SessionInfo) {
  csrf[role] = session.csrf ?? '';
  if (role === 'child') setChildContext(session.personal);
}
