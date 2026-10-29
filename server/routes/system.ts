// What this Jig can do and runs on: capabilities, Meshy credits, the Claude connection, dictation and Bambu Studio.
import express from 'express';
import type { Capabilities, SpeechToken } from '../../shared/api';
import { claudeAuthProblem, defaultEffort, defaultModel, jigCurrency } from '../config';
import { blenderInfo } from '../blend';
import { bambuTemplate, bambuVersion, cachedPrintDefaults } from '../bambu';
import { artworkAvailable, imageModel } from '../artwork';
import { cachedBalance, meshyAvailable, meshyClient } from '../meshy';
import { checkConnection } from '../connection';
import type { MeshyBalance } from '../../shared/api';

/**
 * Dictation languages from ELEVENLABS_LANGUAGE (the main one) and ELEVENLABS_SECONDARY_LANGUAGES
 * (comma-separated), as ISO 639-1/-3 codes; unset means detected automatically.
 */
function speechLanguages(): Pick<SpeechToken, 'language' | 'secondaryLanguages'> {
  const code = (s: string) => s.trim().toLowerCase();
  const valid = (s: string) => /^[a-z]{2,3}$/.test(s);
  const language = code(process.env.ELEVENLABS_LANGUAGE ?? '');
  const secondary = (process.env.ELEVENLABS_SECONDARY_LANGUAGES ?? '').split(',').map(code).filter(valid);
  return { language: valid(language) ? language : undefined, secondaryLanguages: secondary };
}

export function registerSystemRoutes(app: express.Express, { connection }: { connection: typeof checkConnection }) {
  app.get('/api/capabilities', async (_req, res) => {
    const blender = await blenderInfo();
    res.json({ blender: blender?.version ?? null, blenderProblem: blender?.problem ?? null, bambu: await bambuVersion(), speech: !!process.env.ELEVENLABS_API_KEY, printDefaults: await cachedPrintDefaults(), claude: claudeAuthProblem(), artwork: artworkAvailable() ? imageModel() : null, meshy: meshyAvailable(), model: defaultModel(), effort: defaultEffort(), currency: jigCurrency() } satisfies Capabilities);
  });

  // The Meshy account's credits, for the 3D figure button (free to ask; asked at most once a minute).
  app.get('/api/meshy/balance', async (_req, res) => {
    const c = meshyClient();
    if (!c) return void res.status(404).json({ error: 'Jig has no Meshy key (MESHY_API_KEY)' });
    try {
      res.json((await cachedBalance(c)) satisfies MeshyBalance);
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  app.get('/api/connection', async (req, res) => {
    res.json(await connection(req.query.fresh === '1'));
  });

  // Dictation: a single-use token for ElevenLabs' realtime speech-to-text, so the page can stream
  // the microphone there without ever seeing the API key.
  app.post('/api/speech/token', async (_req, res) => {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return void res.status(503).json({ error: 'Dictation needs an ElevenLabs API key: set ELEVENLABS_API_KEY (e.g. in .env) and restart Jig.' });
    try {
      const r = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', { method: 'POST', headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(10000) });
      const body = (await r.json().catch(() => ({}))) as { token?: string; detail?: { message?: string } | string };
      if (!r.ok || !body.token) {
        const why = typeof body.detail === 'string' ? body.detail : body.detail?.message;
        return void res.status(502).json({ error: `ElevenLabs refused the token request (HTTP ${r.status}${why ? `: ${why}` : ''})` });
      }
      res.json({ token: body.token, ...speechLanguages() } satisfies SpeechToken);
    } catch (e) {
      res.status(502).json({ error: `Couldn't reach ElevenLabs: ${(e as Error).message}` });
    }
  });

  // A POST, because the first call runs Bambu Studio for minutes: a GET could be triggered by any
  // website's <img> tag.
  app.post('/api/bambu/template', async (_req, res) => {
    try {
      res.json(await bambuTemplate());
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
}
