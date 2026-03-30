import fs from 'fs';
import path from 'path';

import { DATA_DIR, TIMEZONE, WEBHOOK_BASE_URL } from '../config.js';
import type { ContainerOutput } from '../container-runner.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';
import { createBot, removeBot, sendOutputAudio } from './recall-api.js';
import { synthesizeSpeech } from './google-tts.js';

interface TranscriptSegment {
  speaker: string;
  text: string;
  timestamp: number; // epoch seconds
}

interface MeetSessionState {
  botId: string;
  meetingUrl: string;
  originatingJid: string | null; // null for direct/CLI mode
  originatingGroup: RegisteredGroup | null;
  status: 'joining' | 'in_call' | 'done' | 'error';
  transcriptBuffer: TranscriptSegment[];
  lastProcessedIndex: number;
  isProcessing: boolean;
  pendingRecheck: boolean;
  createdAt: number;
}

export interface MeetServiceDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  runAgent: (
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  getMainGroup: () => RegisteredGroup | undefined;
  assistantName: string;
}

export class MeetService {
  private sessions = new Map<string, MeetSessionState>();
  private deps: MeetServiceDeps;
  private namePattern: RegExp;

  constructor(deps: MeetServiceDeps) {
    this.deps = deps;
    this.namePattern = new RegExp(
      `\\b${escapeRegex(deps.assistantName)}\\b`,
      'i',
    );
  }

  async joinMeeting(
    meetingUrl: string,
    originatingJid: string,
    group: RegisteredGroup,
  ): Promise<string> {
    // Check for duplicate
    const existing = this.getSessionByMeetingUrl(meetingUrl);
    if (existing) {
      throw new Error(`Already in that meeting (bot ${existing.botId})`);
    }

    const bot = await createBot({
      meetingUrl,
      botName: this.deps.assistantName,
      transcriptWebhookUrl: `${WEBHOOK_BASE_URL}/webhook/recall/transcript`,
      statusWebhookUrl: `${WEBHOOK_BASE_URL}/webhook/recall/status`,
    });

    const session: MeetSessionState = {
      botId: bot.id,
      meetingUrl,
      originatingJid,
      originatingGroup: group,
      status: 'joining',
      transcriptBuffer: [],
      lastProcessedIndex: 0,
      isProcessing: false,
      pendingRecheck: false,
      createdAt: Date.now(),
    };

    this.sessions.set(bot.id, session);
    logger.info(
      { botId: bot.id, meetingUrl },
      'Meet session created',
    );

    return bot.id;
  }

  async joinMeetingDirect(meetingUrl: string): Promise<string> {
    const existing = this.getSessionByMeetingUrl(meetingUrl);
    if (existing) {
      throw new Error(`Already in that meeting (bot ${existing.botId})`);
    }

    const bot = await createBot({
      meetingUrl,
      botName: this.deps.assistantName,
      transcriptWebhookUrl: `${WEBHOOK_BASE_URL}/webhook/recall/transcript`,
      statusWebhookUrl: `${WEBHOOK_BASE_URL}/webhook/recall/status`,
    });

    const session: MeetSessionState = {
      botId: bot.id,
      meetingUrl,
      originatingJid: null,
      originatingGroup: null,
      status: 'joining',
      transcriptBuffer: [],
      lastProcessedIndex: 0,
      isProcessing: false,
      pendingRecheck: false,
      createdAt: Date.now(),
    };

    this.sessions.set(bot.id, session);
    logger.info({ botId: bot.id, meetingUrl }, 'Meet session created (direct mode)');
    return bot.id;
  }

  async handleTranscript(
    botId: string,
    transcriptData: {
      words?: Array<{ text: string; start_timestamp?: { relative: number }; end_timestamp?: { relative: number } | null }>;
      participant?: { id: number; name: string | null };
    },
  ): Promise<void> {
    const session = this.sessions.get(botId);
    if (!session) {
      logger.warn({ botId }, 'Transcript for unknown bot');
      return;
    }

    if (!transcriptData.words || transcriptData.words.length === 0) return;

    const speakerName = transcriptData.participant?.name || `Speaker ${transcriptData.participant?.id ?? '?'}`;
    const text = transcriptData.words.map((w) => w.text).join(' ');
    const timestamp = transcriptData.words[0].start_timestamp?.relative ?? Date.now() / 1000;

    session.transcriptBuffer.push({ speaker: speakerName, text, timestamp });

    logger.debug(
      { botId, speaker: speakerName, chars: text.length },
      'Transcript segment buffered',
    );

    // Check if the agent was addressed
    if (this.namePattern.test(text)) {
      logger.info({ botId, speaker: speakerName }, 'Agent addressed in meeting');
      await this.processTranscriptBuffer(session);
    }
  }

  async handleStatusChange(botId: string, statusCode: string): Promise<void> {
    const session = this.sessions.get(botId);
    if (!session) {
      logger.debug({ botId, statusCode }, 'Status change for unknown bot');
      return;
    }

    logger.info({ botId, statusCode }, 'Meet bot status change');

    switch (statusCode) {
      case 'in_call_recording':
        session.status = 'in_call';
        await this.notifyChannel(session, 'Joined the meeting and listening.');
        break;

      case 'done':
      case 'call_ended':
        await this.endSession(botId, 'meeting ended');
        break;

      case 'fatal':
        session.status = 'error';
        await this.notifyChannel(session, 'Failed to stay in the meeting. The bot encountered an error.');
        this.sessions.delete(botId);
        break;

      case 'recording_permission_denied':
        await this.notifyChannel(session, 'The meeting host denied recording permission. Leaving.');
        await this.endSession(botId, 'permission denied');
        break;
    }
  }

  private async processTranscriptBuffer(
    session: MeetSessionState,
  ): Promise<void> {
    if (session.isProcessing) {
      session.pendingRecheck = true;
      return;
    }
    session.isProcessing = true;

    try {
      // Collect all segments since last processing as context
      const segments = session.transcriptBuffer.slice(
        session.lastProcessedIndex,
      );
      session.lastProcessedIndex = session.transcriptBuffer.length;

      if (segments.length === 0) return;

      const group = session.originatingGroup ?? this.deps.getMainGroup();
      if (!group) {
        logger.warn({ botId: session.botId }, 'No group available to run agent — skipping response');
        return;
      }

      const prompt = this.formatTranscriptPrompt(session, segments);
      let responseText = '';
      const chatJid = session.originatingJid ?? 'meet:direct';

      logger.info({ botId: session.botId }, 'Sending transcript to Claude agent');

      const result = await this.deps.runAgent(
        group,
        prompt,
        chatJid,
        async (output) => {
          if (output.result) {
            const raw =
              typeof output.result === 'string'
                ? output.result
                : JSON.stringify(output.result);
            const text = raw
              .replace(/<internal>[\s\S]*?<\/internal>/g, '')
              .trim();
            if (text) {
              responseText += (responseText ? ' ' : '') + text;
            }
          }
          if (output.status === 'success') {
            // Signal the container to close stdin so runAgent returns
            const groupFolder = group.folder;
            const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
            try {
              fs.mkdirSync(inputDir, { recursive: true });
              fs.writeFileSync(path.join(inputDir, '_close'), '');
              logger.debug({ groupFolder }, 'Wrote _close signal for meet container');
            } catch {
              // ignore
            }
          }
        },
      );

      logger.info({ botId: session.botId, result, responseLength: responseText.length }, 'Agent completed');

      if (result === 'success' && responseText) {
        await this.deliverResponse(session, responseText);
      } else {
        logger.warn({ botId: session.botId, result, responseText }, 'No response to deliver');
      }
    } catch (err) {
      logger.error({ err, botId: session.botId }, 'Error processing transcript');
    } finally {
      session.isProcessing = false;
      // Re-check if new mentions arrived while we were processing
      if (session.pendingRecheck) {
        session.pendingRecheck = false;
        const newSegments = session.transcriptBuffer.slice(
          session.lastProcessedIndex,
        );
        const hasNewMention = newSegments.some((s) =>
          this.namePattern.test(s.text),
        );
        if (hasNewMention) {
          await this.processTranscriptBuffer(session);
        }
      }
    }
  }

  private async notifyChannel(
    session: MeetSessionState,
    text: string,
  ): Promise<void> {
    if (!session.originatingJid) {
      logger.info({ botId: session.botId }, text);
      return;
    }
    await this.deps
      .sendMessage(session.originatingJid, text)
      .catch((err) => logger.error({ err }, 'Failed to notify channel'));
  }

  private async deliverResponse(
    session: MeetSessionState,
    text: string,
  ): Promise<void> {
    // Send text to originating channel (if available)
    await this.notifyChannel(session, `[Meeting] ${text}`);

    // Convert to audio and send to meeting
    try {
      const audioBase64 = await synthesizeSpeech(text);
      await sendOutputAudio(session.botId, audioBase64);
      logger.info({ botId: session.botId }, 'Audio response sent to meeting');
    } catch (err) {
      logger.error(
        { err, botId: session.botId },
        'Failed to send audio to meeting (text was still sent to channel)',
      );
    }
  }

  private formatTranscriptPrompt(
    session: MeetSessionState,
    segments: TranscriptSegment[],
  ): string {
    const utterances = segments
      .map((s) => {
        const time = formatTime(s.timestamp);
        return `<utterance speaker="${escapeXml(s.speaker)}" time="${escapeXml(time)}">${escapeXml(s.text)}</utterance>`;
      })
      .join('\n');

    return [
      `<context timezone="${escapeXml(TIMEZONE)}" mode="voice_meeting" />`,
      `<system>You are participating in a live Google Meet call as "${this.deps.assistantName}". Someone addressed you by name. Respond concisely (1-3 sentences) — your response will be spoken aloud via text-to-speech. Do not use markdown formatting, bullet points, or code blocks. Speak naturally as you would in a meeting.</system>`,
      `<transcript meeting_url="${escapeXml(session.meetingUrl)}">`,
      utterances,
      `</transcript>`,
    ].join('\n');
  }

  async endSession(botId: string, reason: string): Promise<void> {
    const session = this.sessions.get(botId);
    if (!session) return;

    session.status = 'done';
    logger.info({ botId, reason }, 'Ending meet session');

    await removeBot(botId);
    await this.notifyChannel(session, `Left the meeting (${reason}).`);

    this.sessions.delete(botId);
  }

  getSessionByMeetingUrl(url: string): MeetSessionState | undefined {
    for (const session of this.sessions.values()) {
      if (session.meetingUrl === url) return session;
    }
    return undefined;
  }

  async cleanup(): Promise<void> {
    const botIds = [...this.sessions.keys()];
    for (const botId of botIds) {
      await this.endSession(botId, 'shutdown').catch((err) =>
        logger.error({ err, botId }, 'Error cleaning up meet session'),
      );
    }
  }
}

// --- Helpers ---

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatTime(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: TIMEZONE,
  });
}
