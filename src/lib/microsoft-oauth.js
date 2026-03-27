const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const APP_URL = process.env.APP_URL || 'https://mrdelegate.ai';

export const MICROSOFT_REDIRECT_URI = `${APP_URL}/api/oauth/microsoft/callback`;
export const MICROSOFT_SCOPES = [
  'Mail.Read',
  'Mail.Send',
  'Mail.ReadWrite',
  'Calendars.Read',
  'Calendars.ReadWrite',
  'offline_access',
  'openid',
  'profile',
  'email',
].join(' ');

export function isMicrosoftOAuthConfigured() {
  return !!(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET);
}

function requireMicrosoftConfig() {
  if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET) {
    throw new Error('Microsoft OAuth not configured');
  }
}

function buildTokenParams(extra) {
  requireMicrosoftConfig();
  return new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    client_secret: MICROSOFT_CLIENT_SECRET,
    redirect_uri: MICROSOFT_REDIRECT_URI,
    ...extra,
  });
}

async function parseMicrosoftResponse(response) {
  const data = await response.json();
  if (!response.ok || data.error) {
    const message = data.error_description || data.error || `HTTP ${response.status}`;
    const error = new Error(message);
    error.code = data.error || 'microsoft_oauth_error';
    error.response = data;
    throw error;
  }
  return data;
}

export function buildMicrosoftAuthUrl(state) {
  requireMicrosoftConfig();

  const authUrl = new URL(MICROSOFT_AUTH_URL);
  authUrl.searchParams.set('client_id', MICROSOFT_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', MICROSOFT_REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('response_mode', 'query');
  authUrl.searchParams.set('scope', MICROSOFT_SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt', 'select_account');
  return authUrl.toString();
}

export async function exchangeMicrosoftCode(code) {
  const response = await fetch(MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildTokenParams({
      code,
      grant_type: 'authorization_code',
    }),
  });

  return parseMicrosoftResponse(response);
}

export async function refreshMicrosoftToken(refreshToken) {
  const response = await fetch(MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildTokenParams({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  return parseMicrosoftResponse(response);
}

export async function fetchMicrosoftProfile(accessToken) {
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    const message = data.error?.message || `HTTP ${response.status}`;
    const error = new Error(message);
    error.code = data.error?.code || 'microsoft_profile_error';
    error.response = data;
    throw error;
  }

  return data;
}
