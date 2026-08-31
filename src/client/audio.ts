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
    try {
      context.current ??= new AudioContext();
      if (context.current.state === 'suspended') void context.current.resume().catch(() => undefined);
      return context.current;
    } catch {
      // Web Audio may be blocked, unavailable, or disabled by the browser.
      // Sound is optional and must never interfere with gameplay.
      return undefined;
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('cambrio:audio', JSON.stringify(settings));
    } catch {
      // Storage can be disabled independently of Web Audio. Preferences then
      // remain tab-local without making sound settings a gameplay failure.
    }
  }, [settings]);

  useEffect(() => {
    if (!settings.effects && !settings.ambience) return;
    const unlock = () => { getContext(); };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [getContext, settings.ambience, settings.effects]);

  useEffect(() => {
    if (!settings.ambience) return;
    const audio = getContext();
    if (!audio) return;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 55;
    gain.gain.value = 0.008;
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    ambienceNodes.current = { oscillator, gain };
    const syncVisibility = () => {
      const operation = document.hidden ? audio.suspend() : audio.resume();
      void operation.catch(() => undefined);
    };
    document.addEventListener('visibilitychange', syncVisibility);
    return () => {
      document.removeEventListener('visibilitychange', syncVisibility);
      try { oscillator.stop(); } catch { /* already stopped */ }
      oscillator.disconnect();
      gain.disconnect();
      if (ambienceNodes.current?.oscillator === oscillator) ambienceNodes.current = undefined;
    };
  }, [getContext, settings.ambience]);

  useEffect(() => () => {
    const audio = context.current;
    context.current = undefined;
    if (audio && audio.state !== 'closed') void audio.close().catch(() => undefined);
  }, []);

  const playNotice = useCallback((notice: ServerNotice) => {
    if (!settings.effects) return;
    const audio = getContext();
    if (!audio) return;
    const profile = notice.kind === 'penalty' || notice.kind === 'stack_lock'
      ? { start: 185, end: 112, duration: 0.2, gain: 0.031, wave: 'triangle' as OscillatorType }
      : notice.kind === 'stack'
        ? { start: 520, end: 760, duration: 0.16, gain: 0.034, wave: 'sine' as OscillatorType }
        : notice.kind === 'cambio'
          ? { start: 330, end: 520, duration: 0.24, gain: 0.031, wave: 'triangle' as OscillatorType }
          : notice.kind === 'results'
            ? { start: 470, end: 705, duration: 0.26, gain: 0.032, wave: 'sine' as OscillatorType }
            : notice.kind === 'power' || notice.kind === 'peek'
              ? { start: 390, end: 545, duration: 0.17, gain: 0.026, wave: 'sine' as OscillatorType }
              : { start: 285, end: 350, duration: 0.15, gain: 0.024, wave: 'sine' as OscillatorType };
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = profile.wave;
    oscillator.frequency.setValueAtTime(profile.start, audio.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(profile.end, audio.currentTime + profile.duration * 0.72);
    // Fade in briefly instead of starting at full gain; this removes the
    // synthetic click that becomes tiring across repeated rounds.
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(profile.gain, audio.currentTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + profile.duration);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start();
    oscillator.stop(audio.currentTime + profile.duration + 0.01);
  }, [getContext, settings.effects]);

  const playTurn = useCallback(() => {
    if (!settings.effects) return;
    const audio = getContext();
    if (!audio) return;
    [0, 0.09].forEach((offset, index) => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(index === 0 ? 440 : 660, audio.currentTime + offset);
      gain.gain.setValueAtTime(0.0001, audio.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.028, audio.currentTime + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + offset + 0.13);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(audio.currentTime + offset);
      oscillator.stop(audio.currentTime + offset + 0.14);
    });
  }, [getContext, settings.effects]);

  return {
    settings,
    toggleEffects: () => setSettings((value) => ({ ...value, effects: !value.effects })),
    toggleAmbience: () => setSettings((value) => ({ ...value, ambience: !value.ambience })),
    playNotice,
    playTurn,
  };
}
