import { isLesson, type Lesson } from './LessonBuilder';

const BASE = '/api/lesson-builder';
const OFFLINE_MESSAGE = 'Start the local lesson builder with npm run lesson-builder, then retry.';

export interface LessonEntry {
  folder: string;
  lesson: Lesson;
}

async function jsonRequest(url: string, init?: RequestInit): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error(OFFLINE_MESSAGE);
  }
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : OFFLINE_MESSAGE);
  }
  if (!body) throw new Error(OFFLINE_MESSAGE);
  return { response, body };
}

function lessonEntry(value: unknown): value is LessonEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.folder === 'string' && /^[a-zA-Z0-9_-]+-v1$/.test(entry.folder) && isLesson(entry.lesson);
}

export async function checkHealth(): Promise<{ status: string; schemaVersion: number }> {
  const { body } = await jsonRequest(`${BASE}/health`);
  const health = body as Record<string, unknown>;
  if (typeof health.status !== 'string' || health.schemaVersion !== 1) {
    throw new Error('The lesson builder returned incompatible health metadata. Restart it and retry.');
  }
  return { status: health.status, schemaVersion: health.schemaVersion };
}

export async function listLessons(): Promise<LessonEntry[]> {
  const { body } = await jsonRequest(`${BASE}/lessons`);
  const lessons = (body as { lessons?: unknown }).lessons;
  if (!Array.isArray(lessons) || !lessons.every(lessonEntry)) {
    throw new Error('The lesson builder returned incompatible lesson metadata. Restart it and retry.');
  }
  return lessons;
}

export async function getLesson(folder: string): Promise<LessonEntry> {
  const { body } = await jsonRequest(`${BASE}/lessons/${encodeURIComponent(folder)}`);
  if (!lessonEntry(body)) throw new Error('The lesson builder returned incompatible lesson metadata. Restart it and retry.');
  return body;
}

export async function importLocalFile(file: File, ownerConfirmedPermission: boolean): Promise<LessonEntry> {
  const { body } = await jsonRequest(`${BASE}/import-local`, {
    method: 'POST',
    body: file,
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Owner-Confirmed-Permission': String(ownerConfirmedPermission),
    },
  });
  if (!lessonEntry(body)) throw new Error('The lesson builder returned incompatible lesson metadata. Restart it and retry.');
  return body;
}

export async function importUrl(url: string, ownerConfirmedPermission: boolean): Promise<LessonEntry> {
  const { body } = await jsonRequest(`${BASE}/import-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, ownerConfirmedPermission }),
  });
  if (!lessonEntry(body)) throw new Error('The lesson builder returned incompatible lesson metadata. Restart it and retry.');
  return body;
}

export async function saveAnnotations(folder: string, humanAnnotations: Record<string, unknown>): Promise<{
  schemaVersion: number;
  revision: number;
  humanAnnotations: Record<string, unknown>;
}> {
  const { body } = await jsonRequest(`${BASE}/lessons/${encodeURIComponent(folder)}/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ humanAnnotations }),
  });
  const result = body as Record<string, unknown>;
  if (result.schemaVersion !== 1 || !Number.isInteger(result.revision) || !result.humanAnnotations
    || typeof result.humanAnnotations !== 'object' || Array.isArray(result.humanAnnotations)) {
    throw new Error('The lesson builder returned an incompatible annotation revision. Restart it and retry.');
  }
  return {
    schemaVersion: result.schemaVersion,
    revision: result.revision as number,
    humanAnnotations: result.humanAnnotations as Record<string, unknown>,
  };
}

export function lessonFileUrl(folder: string, filename: string): string {
  return `${BASE}/lessons/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
}

// Module summary: This is the browser boundary for the loopback-only lesson builder service.
// Successful replies are validated before entering editor state, while server-authored errors remain verbatim.
// Hosted builds need their own compatible API because Vite's proxy and Python service are development-only.
