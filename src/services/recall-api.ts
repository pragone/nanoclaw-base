import { RECALL_API_KEY, RECALL_REGION } from '../config.js';
import { logger } from '../logger.js';

const BASE_URL = `https://${RECALL_REGION}.recall.ai`;

export interface RecallBotConfig {
  meetingUrl: string;
  botName: string;
  transcriptWebhookUrl: string;
  statusWebhookUrl: string;
}

export interface RecallBot {
  id: string;
  status_changes: Array<{ code: string; created_at: string }>;
  meeting_url: string;
}

async function recallFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Token ${RECALL_API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: options.signal ?? AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Recall.ai ${res.status}: ${body}`);
  }
  return res;
}

export async function createBot(config: RecallBotConfig): Promise<RecallBot> {
  logger.info({ meetingUrl: config.meetingUrl }, 'Creating Recall.ai bot');
  const res = await recallFetch('/api/v1/bot/', {
    method: 'POST',
    body: JSON.stringify({
      meeting_url: config.meetingUrl,
      bot_name: config.botName,
      recording_config: {
        transcript: {
          provider: {
            meeting_captions: {},
          },
        },
        realtime_endpoints: [
          {
            type: 'webhook',
            url: config.transcriptWebhookUrl,
            events: ['transcript.data'],
          },
        ],
      },
      chat: {
        on_bot_join: {
          send_to: 'everyone',
          message: `${config.botName} has joined and is listening.`,
        },
      },
      automatic_leave: {
        waiting_room_timeout: 120,
        noone_joined_timeout: 120,
        everyone_left_timeout: 30,
      },
    }),
  });
  return (await res.json()) as RecallBot;
}

export async function getBotStatus(botId: string): Promise<RecallBot> {
  const res = await recallFetch(`/api/v1/bot/${botId}/`);
  return (await res.json()) as RecallBot;
}

export async function sendOutputAudio(
  botId: string,
  audioBase64: string,
): Promise<void> {
  logger.debug({ botId }, 'Sending output audio to Recall.ai bot');
  await recallFetch(`/api/v1/bot/${botId}/output_audio/`, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'mp3',
      b64_data: audioBase64,
    }),
  });
}

export async function removeBot(botId: string): Promise<void> {
  logger.info({ botId }, 'Removing Recall.ai bot');
  await recallFetch(`/api/v1/bot/${botId}/leave_call/`, {
    method: 'POST',
  }).catch((err) => {
    logger.warn({ err, botId }, 'Failed to remove Recall.ai bot (may already be gone)');
  });
}
