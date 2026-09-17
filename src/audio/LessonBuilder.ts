export type LessonReadiness = 'reference_only' | 'paired_sources' | 'paired_actions';

export interface LessonSegment {
  startSeconds: number;
  endSeconds: number;
}

export interface LessonProvenance {
  sourceType: 'local_file' | 'url';
  url: string | null;
  creator: string | null;
  uploader?: string | null;
  uploadDate: string | null;
  platform?: string | null;
  importedAt: string;
  fileHash: string;
  ffmpegVersion: string;
  ffprobeVersion: string;
  ytDlpVersion: string | null;
  [key: string]: unknown;
}

export interface LessonAudio {
  referenceFile: 'reference.wav';
  referenceStartSeconds: number;
  originalDurationSeconds: number;
  referenceDurationSeconds: number;
  referenceSampleRate: number;
  referenceChannels: number;
  analysisSampleRate: number;
  trimOffsetSeconds: number;
  transformations: Array<{ step: string; tool: string; params: Record<string, unknown> }>;
}

export interface LessonRhythm {
  bpm: number | null;
  beatTimes: number[];
  gridOffsetSeconds: number | null;
  confidence: { score: number; kind: 'heuristic'; regularity: number; onsetSupport: number };
  tempoAlternatives: number[];
  onsetTimes: number[];
  warnings: string[];
}

export interface PossibleKey {
  key: string;
  correlation: number;
  confidence: number;
}

export interface SuggestedTransitionRegion {
  startSeconds: number;
  endSeconds: number;
  confidence: number;
  label: 'suggested';
}

export interface LessonHeuristicEstimates {
  rhythm: LessonRhythm;
  chroma: { npzKey: string };
  possibleKeys: PossibleKey[];
  suggestedTransitionRegions: SuggestedTransitionRegion[];
  qualityRegions?: Record<string, Array<Record<string, unknown>>>;
  warnings: string[];
}

export interface ObservedControllerAction {
  timestamp: number;
  type: 'mixer_rates';
  values: [number, number];
  source: 'controller_log' | 'authored';
}

export interface Lesson {
  schemaVersion: 1;
  lessonId: string;
  title: string;
  readiness: LessonReadiness;
  performance_group_id: string;
  segment: LessonSegment;
  timeline: string;
  provenance: LessonProvenance;
  audio: LessonAudio;
  analysisVersion: { lessonBuilder: string; rhythmAlgorithm: string; rhythmCacheVersion: string };
  measured: {
    times: { npzKey: string };
    rms: { npzKey: string };
    spectralFlux: { npzKey: string };
    bandEnergy: { npzKey: string };
  };
  heuristicEstimates: LessonHeuristicEstimates;
  humanAnnotations: Record<string, unknown>;
  observedControllerActions: ObservedControllerAction[] | null;
  sources: Record<string, unknown>;
  featuresManifest: Record<string, unknown>;
  [key: string]: unknown;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const score = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

function orderedTimes(value: unknown, duration: number): value is number[] {
  return Array.isArray(value) && value.length <= 100000
    && value.every((time, index) => finite(time) && time >= 0 && time <= duration
      && (index === 0 || time > value[index - 1]));
}

export function isLesson(value: unknown): value is Lesson {
  if (!object(value)) return false;
  const segment = value.segment;
  const audio = value.audio;
  const provenance = value.provenance;
  const versions = value.analysisVersion;
  const measured = value.measured;
  const estimates = value.heuristicEstimates;
  if (!object(segment) || !object(audio) || !object(provenance) || !object(versions)
    || !object(measured) || !object(estimates) || !object(value.humanAnnotations)
    || !object(value.sources) || !object(value.featuresManifest)) return false;

  const duration = audio.referenceDurationSeconds;
  const rhythm = estimates.rhythm;
  const chroma = estimates.chroma;
  if (!finite(duration) || duration <= 0 || duration > 600 || !object(rhythm) || !object(chroma)) return false;
  const confidence = rhythm.confidence;
  if (!object(confidence)) return false;

  const possibleKeys = estimates.possibleKeys;
  const regions = estimates.suggestedTransitionRegions;
  const actions = value.observedControllerActions;
  const validActions = actions === null || (Array.isArray(actions) && actions.every(action => object(action)
    && finite(action.timestamp) && action.timestamp >= 0
    && action.type === 'mixer_rates' && (action.source === 'controller_log' || action.source === 'authored')
    && Array.isArray(action.values) && action.values.length === 2
    && action.values.every(item => finite(item) && item >= -1 && item <= 1)));

  return value.schemaVersion === 1
    && typeof value.lessonId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value.lessonId)
    && typeof value.title === 'string'
    && ['reference_only', 'paired_sources', 'paired_actions'].includes(String(value.readiness))
    && typeof value.performance_group_id === 'string' && value.performance_group_id.length > 0
    && finite(segment.startSeconds) && finite(segment.endSeconds)
    && segment.startSeconds >= 0 && segment.endSeconds > segment.startSeconds
    && typeof value.timeline === 'string' && value.timeline.length > 0
    && (provenance.sourceType === 'local_file' || provenance.sourceType === 'url')
    && (provenance.url === null || typeof provenance.url === 'string')
    && (provenance.creator === null || typeof provenance.creator === 'string')
    && (provenance.uploadDate === null || typeof provenance.uploadDate === 'string')
    && typeof provenance.importedAt === 'string' && typeof provenance.fileHash === 'string'
    && typeof provenance.ffmpegVersion === 'string' && typeof provenance.ffprobeVersion === 'string'
    && (provenance.ytDlpVersion === null || typeof provenance.ytDlpVersion === 'string')
    && audio.referenceFile === 'reference.wav'
    && finite(audio.referenceStartSeconds) && finite(audio.originalDurationSeconds) && audio.originalDurationSeconds > 0
    && finite(audio.referenceSampleRate) && audio.referenceSampleRate > 0
    && finite(audio.referenceChannels) && Number.isInteger(audio.referenceChannels) && audio.referenceChannels > 0
    && finite(audio.analysisSampleRate) && audio.analysisSampleRate > 0
    && finite(audio.trimOffsetSeconds) && Array.isArray(audio.transformations)
    && audio.transformations.every(item => object(item) && typeof item.step === 'string'
      && typeof item.tool === 'string' && object(item.params))
    && typeof versions.lessonBuilder === 'string' && typeof versions.rhythmAlgorithm === 'string'
    && typeof versions.rhythmCacheVersion === 'string'
    && ['times', 'rms', 'spectralFlux', 'bandEnergy'].every(name => object(measured[name])
      && typeof measured[name].npzKey === 'string')
    && (rhythm.bpm === null || (finite(rhythm.bpm) && rhythm.bpm > 0 && rhythm.bpm <= 1000))
    && (rhythm.gridOffsetSeconds === null || (finite(rhythm.gridOffsetSeconds) && rhythm.gridOffsetSeconds >= 0
      && rhythm.gridOffsetSeconds <= audio.originalDurationSeconds))
    && orderedTimes(rhythm.beatTimes, audio.originalDurationSeconds)
    && orderedTimes(rhythm.onsetTimes, audio.originalDurationSeconds)
    && confidence.kind === 'heuristic' && score(confidence.score)
    && score(confidence.regularity) && score(confidence.onsetSupport)
    && Array.isArray(rhythm.tempoAlternatives) && rhythm.tempoAlternatives.every(item => finite(item) && item > 0)
    && strings(rhythm.warnings)
    && chroma.npzKey === 'chroma'
    && Array.isArray(possibleKeys) && possibleKeys.length <= 100
    && possibleKeys.every(item => object(item) && typeof item.key === 'string'
      && finite(item.correlation) && score(item.confidence))
    && Array.isArray(regions) && regions.length <= 1000
    && regions.every(region => object(region) && region.label === 'suggested'
      && finite(region.startSeconds) && finite(region.endSeconds) && region.startSeconds >= 0
      && region.endSeconds > region.startSeconds && score(region.confidence))
    && strings(estimates.warnings)
    && validActions;
}

// Module summary: This describes and validates the versioned lesson metadata used by the editor.
// It keeps measurements, heuristic candidates, human review, and observed controller evidence distinct.
// Structural validation cannot establish that a musically plausible suggestion or provenance claim is correct.
