import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerNotice } from '../shared/protocol.js';

type AudioSettings = { effects: boolean; ambience: boolean };
const defaults: AudioSettings = { effects: true, ambience: false };

export function useGameAudio() {
  const [settings, setSettings] = useState<AudioSettings>(() => {
    try {
      return { ...defaults, ...JSON.parse(localStorage.getItem('cambrio:audio') ?? '{}') };
    } catch {
      return defaults;
    }
  });
  const context = useRef<AudioContext | undefined>(undefined);
  const ambienceNodes = useRef<{ oscillator: OscillatorNode; gain: GainNode } | undefined>(undefined);

  const getContext = useCallback(() => {
    context.current ??= new AudioContext();
    void context.current.resume();
    return context.current;
  }, []);

  useEffect(() => {
    localStorage.setItem('cambrio:audio', JSON.stringify(settings));
    if (!settings.ambience) {
      ambienceNodes.current?.oscillator.stop();
      ambienceNodes.current = undefined;
      return;
    }
    const audio = getContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 55;
    gain.gain.value = 0.008;
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    ambienceNodes.current = { oscillator, gain };
    return () => {
      try { oscillator.stop(); } catch { /* already stopped */ }
    };
  }, [getContext, settings]);

  const playNotice = useCallback((notice: ServerNotice) => {
    if (!settings.effects) return;
    const audio = getContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const frequency = notice.kind === 'penalty' ? 145 : notice.kind === 'stack' ? 620 : notice.kind === 'results' ? 520 : 300;
    oscillator.frequency.setValueAtTime(frequency, audio.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(80, frequency * 1.3), audio.currentTime + 0.12);
    gain.gain.setValueAtTime(0.045, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.16);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.17);
  }, [getContext, settings.effects]);

  return {
    settings,
    toggleEffects: () => setSettings((value) => ({ ...value, effects: !value.effects })),
    toggleAmbience: () => setSettings((value) => ({ ...value, ambience: !value.ambience })),
    playNotice,
  };
}
