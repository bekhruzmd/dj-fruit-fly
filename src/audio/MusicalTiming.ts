export interface MusicalTiming {
  hasPhraseGrid?: boolean; // False for imported tracks without bar/phrase annotations.
  totalBeats: number;
  beat: number;
  bar: number;
  phraseStep: number;
  isDownbeat: boolean;
  isPhraseDrop: boolean;
  isBuildup: boolean;
}

export function musicalTiming(elapsed: number, bpm: number): MusicalTiming {
  const totalBeats = Math.max(0, elapsed) * bpm / 60;
  const beat = Math.floor(totalBeats) % 4 + 1;
  const bar = Math.floor(totalBeats / 4) % 8 + 1;
  const fraction = totalBeats % 1;
  return {
    totalBeats, beat, bar, phraseStep: Math.floor(totalBeats) % 32,
    isDownbeat: beat === 1 && fraction < 0.15,
    isPhraseDrop: bar === 1 && beat === 1 && fraction < 0.15,
    isBuildup: bar === 8 && beat >= 3,
  };
}

// Deck-specific low shelves: only one deck owns the kick during an overlap.
// The audio engine ramps the handoff to avoid clicks.
export function bassGains(crossfader: number): [number, number] {
  return crossfader < 0.5 ? [0, -24] : [-24, 0];
}
