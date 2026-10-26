import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const prodEnv = {
  APP_MODE: 'production',
  PUBLIC_BASE_URL: 'https://recaps.example.run.app/',
  FIREFLIES_API_KEY: 'k',
  FIREFLIES_WEBHOOK_SECRET: 'x'.repeat(32),
  GOOGLE_OAUTH_CLIENT_ID: 'id.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 's',
  GOOGLE_AUTHORIZED_USER_EMAIL: 'Me@OrcaRehab.example',
  GOOGLE_CHAT_SPACE: 'spaces/AAAAabc123',
  OAUTH_ADMIN_TOKEN: 'a'.repeat(48),
  GOOGLE_CLOUD_PROJECT: 'proj',
  TASKS_LOCATION: 'us-west1',
  TASKS_QUEUE: 'fireflies-recaps',
  TASKS_INVOKER_SERVICE_ACCOUNT: 'tasks-invoker@proj.iam.gserviceaccount.com',
};

describe('configuration', () => {
  it('loads a complete production config with safe defaults', () => {
    const c = loadConfig(prodEnv);
    expect(c.storeBackend).toBe('firestore');
    expect(c.queueBackend).toBe('cloudtasks');
    expect(c.tokenStoreBackend).toBe('secretmanager');
    expect(c.meetingRules).toEqual([]);
    expect(c.dryRun).toBe(false);
    expect(c.google.redirectUri).toBe('https://recaps.example.run.app/oauth/callback');
    expect(c.google.authorizedUserEmail).toBe('me@orcarehab.example');
    expect(c.tasks.audience).toBe('https://recaps.example.run.app');
  });

  it('refuses non-durable backends and missing settings in production', () => {
    expect(() => loadConfig({ ...prodEnv, STORE_BACKEND: 'memory' })).toThrow(/STORE_BACKEND/);
    expect(() => loadConfig({ ...prodEnv, QUEUE_BACKEND: 'inline' })).toThrow(/QUEUE_BACKEND/);
    expect(() => loadConfig({ ...prodEnv, GOOGLE_CHAT_SPACE: '' })).toThrow(/GOOGLE_CHAT_SPACE/);
    expect(() => loadConfig({ ...prodEnv, PUBLIC_BASE_URL: 'http://x.example' })).toThrow(/https/);
  });

  it('validates formats without echoing secret values', () => {
    try {
      loadConfig({ ...prodEnv, OAUTH_ADMIN_TOKEN: 'short-secret-value', GOOGLE_CHAT_SPACE: 'https://chat.google.com/room/X', MEETING_RULES: '[{"name":"all"}]' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/OAUTH_ADMIN_TOKEN/);
      expect(msg).toMatch(/GOOGLE_CHAT_SPACE/);
      expect(msg).toMatch(/MEETING_RULES/);
      expect(msg).not.toContain('short-secret-value');
    }
  });

  it('allows a minimal local dry-run config', () => {
    const c = loadConfig({ APP_MODE: 'local', DRY_RUN: 'true', PUBLIC_BASE_URL: 'http://localhost:8080', FIREFLIES_WEBHOOK_SECRET: 'local-secret-123456' });
    expect(c.storeBackend).toBe('memory');
    expect(c.queueBackend).toBe('inline');
    expect(c.dryRun).toBe(true);
  });
});
