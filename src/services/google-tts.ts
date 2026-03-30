import { GoogleAuth } from 'google-auth-library';

import { GOOGLE_TTS_API_KEY } from '../config.js';
import { logger } from '../logger.js';

const TTS_URL =
  'https://texttospeech.googleapis.com/v1beta1/text:synthesize';
const DEFAULT_VOICE = 'en-US-Chirp3-HD-Achernar';
const MAX_TTS_CHARS = 500;

// Lazily initialized — uses ADC (gcloud auth application-default login)
let auth: GoogleAuth | undefined;

function getAuth(): GoogleAuth {
  if (!auth) {
    auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }
  return auth;
}

interface SynthesizeResponse {
  audioContent: string; // base64-encoded MP3
}

export async function synthesizeSpeech(
  text: string,
  voiceName: string = DEFAULT_VOICE,
): Promise<string> {
  const truncated =
    text.length > MAX_TTS_CHARS
      ? text.slice(0, MAX_TTS_CHARS) + '...'
      : text;

  logger.debug(
    { chars: truncated.length, voice: voiceName },
    'Synthesizing speech via Google TTS',
  );

  // Build request URL and headers based on auth method
  let url: string;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (GOOGLE_TTS_API_KEY) {
    // API key auth (simple but requires key creation)
    url = `${TTS_URL}?key=${GOOGLE_TTS_API_KEY}`;
  } else {
    // ADC auth (gcloud auth application-default login)
    url = TTS_URL;
    const authClient = getAuth();
    const client = await authClient.getClient();
    const token = await client.getAccessToken();
    headers.Authorization = `Bearer ${token.token}`;
    // ADC requires the quota/billing project header — read from ADC credentials
    const quotaProject =
      (client as { quotaProjectId?: string }).quotaProjectId ??
      (await authClient.getProjectId().catch(() => null));
    if (quotaProject) {
      headers['x-goog-user-project'] = quotaProject;
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      input: { text: truncated },
      voice: {
        languageCode: voiceName.slice(0, 5), // e.g. "en-US"
        name: voiceName,
      },
      audioConfig: { audioEncoding: 'MP3' },
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google TTS ${res.status}: ${body}`);
  }

  const data = (await res.json()) as SynthesizeResponse;
  return data.audioContent;
}
