import type { CombinedSnapshot, SessionStats } from "@shared/types";
import { addWaterCup, computeSessionUsage } from "@shared/session-stats";
import { normalizeWaterCupSize } from "@shared/water";

class SessionTracker {
  private startedAtMs = Date.now();
  private baseline: CombinedSnapshot | null = null;
  private waterMl = 0;
  private waterCups = 0;

  start(startedAtMs: number, baseline: CombinedSnapshot | null): void {
    this.startedAtMs = startedAtMs;
    this.baseline = baseline;
    this.waterMl = 0;
    this.waterCups = 0;
  }

  observeSnapshot(snapshot: CombinedSnapshot): void {
    if (!this.baseline) {
      this.baseline = snapshot;
    }
  }

  logCup(sizeMl: unknown): { waterMl: number; waterCups: number } {
    const next = addWaterCup(
      { waterMl: this.waterMl, waterCups: this.waterCups },
      normalizeWaterCupSize(sizeMl)
    );
    this.waterMl = next.waterMl;
    this.waterCups = next.waterCups;
    return next;
  }

  getStats(
    current: CombinedSnapshot | null,
    nowMs = Date.now(),
    nextWaterAt: string | null = null
  ): SessionStats {
    return {
      startedAt: new Date(this.startedAtMs).toISOString(),
      durationMs: Math.max(0, nowMs - this.startedAtMs),
      waterMl: this.waterMl,
      waterCups: this.waterCups,
      nextWaterAt,
      usage: computeSessionUsage(this.baseline, current)
    };
  }
}

export const sessionTracker = new SessionTracker();
