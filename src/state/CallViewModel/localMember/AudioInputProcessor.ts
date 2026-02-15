/*
Copyright 2026 Element Creations Ltd.
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type LocalAudioTrack } from "livekit-client";
import { type Logger } from "matrix-js-sdk/lib/logger";

export interface AudioInputProcessorOptions {
  noiseGateEnabled: boolean;
  noiseGateThresholdDb: number;
  micBoostDb: number;
}

/**
 * Processing pipeline for local microphone audio before it is sent upstream.
 * This is intentionally separate from mute/publish state so effects (gate, boost,
 * future denoise filters) do not change user mute state.
 */
export class AudioInputProcessor {
  private inputTrackId: string | null = null;
  private outputTrackId: string | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private boostNode: GainNode | null = null;
  private gateNode: GainNode | null = null;
  private sampleBuffer = new Float32Array(2048);
  private gateOpen = true;

  public constructor(
    private options: AudioInputProcessorOptions,
    private readonly logger: Logger,
  ) {}

  public updateOptions(options: Partial<AudioInputProcessorOptions>): void {
    this.options = { ...this.options, ...options };
    if (this.boostNode && this.audioContext) {
      this.boostNode.gain.setValueAtTime(
        this.dbToLinear(this.options.micBoostDb),
        this.audioContext.currentTime,
      );
    }
  }

  public async process(
    localAudioTrack: LocalAudioTrack,
    sourceTrack: MediaStreamTrack,
  ): Promise<void> {
    await this.ensureAttached(localAudioTrack, sourceTrack);
    this.applyNoiseGate();
  }

  public destroy(): void {
    this.sourceNode?.disconnect();
    this.sourceNode = null;
    this.boostNode?.disconnect();
    this.boostNode = null;
    this.gateNode?.disconnect();
    this.gateNode = null;
    this.analyser = null;
    this.inputTrackId = null;
    this.outputTrackId = null;
    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
  }

  private async ensureAttached(
    localAudioTrack: LocalAudioTrack,
    sourceTrack: MediaStreamTrack,
  ): Promise<void> {
    if (this.outputTrackId && sourceTrack.id === this.outputTrackId) return;
    if (this.inputTrackId && sourceTrack.id === this.inputTrackId) return;

    this.destroy();
    this.inputTrackId = sourceTrack.id;

    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(new MediaStream([sourceTrack]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = this.sampleBuffer.length;

    const boost = ctx.createGain();
    boost.gain.value = this.dbToLinear(this.options.micBoostDb);

    const gate = ctx.createGain();
    gate.gain.value = 1;

    const destination = ctx.createMediaStreamDestination();

    source.connect(analyser);
    source.connect(boost);
    boost.connect(gate);
    gate.connect(destination);

    const processedTrack = destination.stream.getAudioTracks()[0];
    if (!processedTrack) return;

    this.audioContext = ctx;
    this.sourceNode = source;
    this.analyser = analyser;
    this.boostNode = boost;
    this.gateNode = gate;
    this.outputTrackId = processedTrack.id;
    this.gateOpen = true;

    try {
      await localAudioTrack.replaceTrack(processedTrack, {
        stopProcessor: true,
      });
    } catch (e) {
      this.logger.error("Failed to attach local audio processor track", e);
    }
  }

  private applyNoiseGate(): void {
    if (!this.analyser || !this.gateNode || !this.audioContext) return;

    if (!this.options.noiseGateEnabled) {
      if (!this.gateOpen) {
        this.gateNode.gain.setValueAtTime(1, this.audioContext.currentTime);
        this.gateOpen = true;
      }
      return;
    }

    this.analyser.getFloatTimeDomainData(this.sampleBuffer);
    let sumSquares = 0;
    for (const sample of this.sampleBuffer) sumSquares += sample * sample;
    const rms = Math.sqrt(sumSquares / this.sampleBuffer.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    const shouldOpen = db >= this.options.noiseGateThresholdDb;

    if (shouldOpen === this.gateOpen) return;
    this.gateOpen = shouldOpen;
    this.gateNode.gain.setValueAtTime(
      shouldOpen ? 1 : 0,
      this.audioContext.currentTime,
    );
  }

  private dbToLinear(db: number): number {
    return Math.pow(10, db / 20);
  }
}
