import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type, type GenerateContentResponse } from '@google/genai';
import { buildOraSystemInstruction } from './src/services/oraChat';
import { requireAuth, type AuthRequest } from './src/middleware/auth.ts';
import {
  deleteSyncedTaskForUser,
  getOrCreateUser,
  listSyncedTasksForUser,
  upsertSyncedTaskForUser,
} from './src/db/tasksRepository.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function createApp() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  const lockoutAlerts = new Map<string, number>();

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'eco-pulse' });
  });

  app.post('/api/auth/lockout-alert', async (req, res) => {
    const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
      res.status(400).json({ error: 'Valid email address is required.', code: 'BAD_REQUEST' });
      return;
    }

    const now = Date.now();
    const lockDurationMs = 15 * 60 * 1000;
    const existingLockUntil = lockoutAlerts.get(rawEmail) ?? 0;
    const lockedUntil = existingLockUntil > now ? existingLockUntil : now + lockDurationMs;
    const alreadySentRecently = existingLockUntil > now;
    lockoutAlerts.set(rawEmail, lockedUntil);

    if (alreadySentRecently) {
      res.json({ ok: true, delivered: false, channel: 'cooldown', lockedUntil });
      return;
    }

    const resendKey = process.env.RESEND_API_KEY?.trim();
    const fromEmail = process.env.ALERT_FROM_EMAIL?.trim() || 'ECO-PULSE Security <onboarding@resend.dev>';

    if (resendKey) {
      try {
        const mailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [rawEmail],
            subject: 'ECO-PULSE Security Alert: 5 Failed Sign-In Attempts',
            text: [
              'We detected 5 consecutive incorrect password attempts on your ECO-PULSE account.',
              'For your protection, sign-in for this email address has been locked for 15 minutes.',
              'If this was not you, we recommend resetting your password immediately from the Sign In screen.',
            ].join('\n\n'),
          }),
        });
        if (mailRes.ok) {
          res.json({ ok: true, delivered: true, channel: 'resend', lockedUntil });
          return;
        }
      } catch (err) {
        console.error('Failed to send lockout alert email via Resend:', err);
      }
    }

    res.json({ ok: true, delivered: false, channel: 'none', lockedUntil });
  });

  app.post('/api/insights', async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'Gemini AI coaching is currently unconfigured on the server. Using deterministic trend analysis.',
        code: 'GEMINI_UNCONFIGURED',
      });
      return;
    }

    const { summary } = req.body ?? {};
    if (!summary || typeof summary !== 'object') {
      res.status(400).json({ error: 'Invalid summary payload.', code: 'BAD_REQUEST' });
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
      const prompt = [
        'Analyze this aggregated environmental footprint summary for an ECO-PULSE user and provide calm, practical, non-judgmental guidance.',
        'Summary JSON:',
        JSON.stringify(summary),
      ].join('\n');

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          abortSignal: controller.signal,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          systemInstruction:
            'You are the ECO-PULSE Environmental Intelligence Coach. Write concise, calm, scientific, guilt-free sustainability observations based strictly on the provided calculated metrics. Never invent numbers, never shame the user, never give medical or financial advice, and never claim exact certainty for estimates. Keep explanations under 2 sentences each.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              headline: {
                type: Type.STRING,
                description: 'Short 6-10 word summary headline.',
              },
              overviewNarrative: {
                type: Type.STRING,
                description: 'Calm 2-sentence interpretation of recent trends.',
              },
              nextActions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    rationale: { type: Type.STRING },
                    category: { type: Type.STRING },
                  },
                },
                description: '3 realistic, low-friction actions for tomorrow.',
              },
            },
          },
        },
      });

      const raw = (response.text ?? '').trim();
      const parsed = JSON.parse(raw);
      res.json({
        source: 'gemini',
        ...parsed,
      });
    } catch (error) {
      const isTimeout = controller.signal.aborted;
      const message = error instanceof Error ? error.message : 'Unable to reach Gemini service.';
      console.error('Gemini insights error:', message);
      res.status(isTimeout ? 504 : 502).json({
        error: isTimeout
          ? 'Gemini coaching timed out. Deterministic analysis remains active.'
          : 'Unable to generate AI narrative right now. Deterministic analysis remains active.',
        code: isTimeout ? 'GEMINI_TIMEOUT' : 'GEMINI_UPSTREAM_ERROR',
      });
    } finally {
      clearTimeout(timeoutId);
    }
  });

  app.post('/api/ora/chat', async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'ORA requires a configured GEMINI_API_KEY in Settings > Secrets.',
        code: 'GEMINI_UNCONFIGURED',
      });
      return;
    }

    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message || message.length > 2000) {
      res.status(400).json({
        error: 'Please enter a message between 1 and 2000 characters.',
        code: 'BAD_REQUEST',
      });
      return;
    }

    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    const safeHistory = rawHistory
      .filter(
        (item: unknown): item is { role: 'user' | 'model'; parts: Array<{ text: string }> } =>
          typeof item === 'object' &&
          item !== null &&
          ((item as { role?: unknown }).role === 'user' ||
            (item as { role?: unknown }).role === 'model') &&
          Array.isArray((item as { parts?: unknown }).parts) &&
          typeof (item as { parts: Array<{ text?: unknown }> }).parts[0]?.text === 'string' &&
          (item as { parts: Array<{ text: string }> }).parts[0].text.trim().length > 0
      )
      .slice(-16)
      .map((item: { role: 'user' | 'model'; parts: Array<{ text: string }> }) => ({
        role: item.role,
        parts: [{ text: item.parts[0].text.trim().slice(0, 4000) }],
      }));

    while (safeHistory.length > 0 && safeHistory[0].role !== 'user') {
      safeHistory.shift();
    }

    const context =
      req.body?.context && typeof req.body.context === 'object' ? req.body.context : null;
    const systemInstruction = buildOraSystemInstruction(context);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    req.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    try {
      const chat = ai.chats.create({
        model: 'gemini-4-hydrogen',
        history: safeHistory,
        config: {
          abortSignal: controller.signal,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          systemInstruction,
        },
      });

      const streamResponse = await chat.sendMessageStream({ message });

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      for await (const chunk of streamResponse) {
        const c = chunk as GenerateContentResponse;
        if (c.text) {
          res.write(`data: ${JSON.stringify({ delta: c.text })}\n\n`);
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (error) {
      const isTimeout = controller.signal.aborted;
      const errMsg = error instanceof Error ? error.message : 'Unable to reach ORA service.';
      console.error('Gemini ORA chat error:', errMsg);
      if (!res.headersSent) {
        res.status(isTimeout ? 504 : 502).json({
          error: isTimeout
            ? 'ORA timed out connecting to the Gemini service. Please try again.'
            : 'ORA could not reach the Gemini service right now. Please try again.',
          code: isTimeout ? 'GEMINI_TIMEOUT' : 'GEMINI_UPSTREAM_ERROR',
        });
      } else {
        res.write(
          `data: ${JSON.stringify({ error: 'ORA connection interrupted. Please try again.' })}\n\n`
        );
        res.end();
      }
    } finally {
      clearTimeout(timeoutId);
    }
  });

  app.post('/api/sql/users/sync', requireAuth, async (req: AuthRequest, res) => {
    const uid = req.user?.uid;
    const email = req.user?.email;
    if (!uid || !email) {
      res.status(400).json({ error: 'Authenticated user profile is incomplete.', code: 'BAD_REQUEST' });
      return;
    }

    try {
      const displayName =
        typeof req.body?.displayName === 'string'
          ? req.body.displayName.trim().slice(0, 120)
          : req.user?.name ?? null;
      const userRow = await getOrCreateUser(uid, email, displayName);
      res.json({ user: userRow });
    } catch (error) {
      console.error('Failed to sync user to Cloud SQL:', error);
      res.status(500).json({ error: 'Unable to sync user record right now.', code: 'DB_ERROR' });
    }
  });

  app.get('/api/sql/synced-tasks', requireAuth, async (req: AuthRequest, res) => {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    try {
      const items = await listSyncedTasksForUser(uid);
      res.json({ items });
    } catch (error) {
      console.error('Failed to list synced tasks:', error);
      res.status(500).json({ error: 'Unable to retrieve synced tasks.', code: 'DB_ERROR' });
    }
  });

  app.post('/api/sql/synced-tasks', requireAuth, async (req: AuthRequest, res) => {
    const uid = req.user?.uid;
    const email = req.user?.email;
    if (!uid || !email) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const googleTaskId =
      typeof req.body?.googleTaskId === 'string' ? req.body.googleTaskId.trim() : '';
    const taskListId =
      typeof req.body?.taskListId === 'string' ? req.body.taskListId.trim() : '';
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';

    if (!googleTaskId || !taskListId || !title) {
      res.status(400).json({ error: 'googleTaskId, taskListId, and title are required.', code: 'BAD_REQUEST' });
      return;
    }

    try {
      const item = await upsertSyncedTaskForUser(uid, email, req.user?.name ?? null, {
        googleTaskId,
        taskListId,
        title,
        notes: typeof req.body?.notes === 'string' ? req.body.notes : null,
        status: req.body?.status === 'completed' ? 'completed' : 'needsAction',
        dueDate: typeof req.body?.dueDate === 'string' ? req.body.dueDate : null,
        linkedMissionId:
          typeof req.body?.linkedMissionId === 'string' ? req.body.linkedMissionId : null,
      });
      res.json({ item });
    } catch (error) {
      console.error('Failed to upsert synced task:', error);
      res.status(500).json({ error: 'Unable to save synced task record.', code: 'DB_ERROR' });
    }
  });

  app.delete('/api/sql/synced-tasks/:googleTaskId', requireAuth, async (req: AuthRequest, res) => {
    const uid = req.user?.uid;
    const googleTaskId = typeof req.params?.googleTaskId === 'string' ? req.params.googleTaskId.trim() : '';
    if (!uid || !googleTaskId) {
      res.status(400).json({ error: 'Valid task identifier is required.', code: 'BAD_REQUEST' });
      return;
    }

    try {
      const removed = await deleteSyncedTaskForUser(uid, googleTaskId);
      res.json({ removed });
    } catch (error) {
      console.error('Failed to delete synced task:', error);
      res.status(500).json({ error: 'Unable to remove synced task record.', code: 'DB_ERROR' });
    }
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Build not found');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ECO-PULSE server listening on http://0.0.0.0:${PORT}`);
  });
}

createApp();
