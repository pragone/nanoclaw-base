import express from 'express';

import { logger } from './logger.js';
import type { MeetService } from './services/meet-session.js';

export function createWebhookServer(meetService: MeetService): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Recall.ai real-time transcription webhook
  app.post('/webhook/recall/transcript', (req, res) => {
    try {
      const payload = req.body?.data;
      const botId = payload?.bot?.id;
      const transcriptData = payload?.data; // words + participant
      if (!botId || !transcriptData) {
        res.status(400).send('missing data');
        return;
      }
      // Fire-and-forget — respond immediately per Recall.ai requirements (< 15s)
      meetService
        .handleTranscript(botId, transcriptData)
        .catch((err) =>
          logger.error({ err, botId }, 'Error handling transcript'),
        );
      res.status(200).send('ok');
    } catch (err) {
      logger.error({ err }, 'Transcript webhook error');
      res.status(500).send('error');
    }
  });

  // Recall.ai bot status change webhook
  app.post('/webhook/recall/status', (req, res) => {
    try {
      const botId =
        req.body?.data?.bot_id ?? req.body?.bot_id;
      const statusCode =
        req.body?.data?.status?.code ?? req.body?.code;
      if (botId && statusCode) {
        meetService
          .handleStatusChange(botId, statusCode)
          .catch((err) =>
            logger.error({ err, botId }, 'Error handling status change'),
          );
      }
      res.status(200).send('ok');
    } catch (err) {
      logger.error({ err }, 'Status webhook error');
      res.status(500).send('error');
    }
  });

  // Manual meet join — trigger from terminal via curl
  app.post('/meet/join', async (req, res) => {
    const { meeting_url } = req.body ?? {};
    if (!meeting_url) {
      res.status(400).json({ error: 'missing meeting_url' });
      return;
    }
    try {
      const botId = await meetService.joinMeetingDirect(meeting_url);
      res.status(200).json({ ok: true, bot_id: botId, meeting_url });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, meeting_url }, 'Failed to join meeting');
      res.status(500).json({ error: message });
    }
  });

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  return app;
}

export function startWebhookServer(
  app: express.Express,
  port: number,
): void {
  app.listen(port, () => {
    logger.info({ port }, 'Webhook server listening');
  });
}
