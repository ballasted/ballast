import { describe, it, expect } from "vitest";
import {
  computeStatus,
  progressPct,
  remainingSpots,
  windowDaysLeft,
  withinWindow,
  MILESTONE_VOLUME_USD,
  MILESTONE_WINDOW_SECONDS,
} from "./creatorFund";

const LAUNCH = 1_000;
const base = {
  launchTs: LAUNCH,
  volumeExcludingFlaggedUsd: 60_000,
  holders: 150,
  creatorHasEarlierQualifier: false,
};

describe("progressPct", () => {
  it("clamps to [0,100]", () => {
    expect(progressPct(25_000, 50_000)).toBe(50);
    expect(progressPct(90_000, 50_000)).toBe(100);
    expect(progressPct(-5, 50_000)).toBe(0);
    expect(progressPct(10, 0)).toBe(0);
  });
});

describe("windowDaysLeft / remainingSpots", () => {
  it("counts whole days left, clamped at 0", () => {
    expect(windowDaysLeft(LAUNCH, LAUNCH)).toBe(14);
    expect(windowDaysLeft(LAUNCH, LAUNCH + MILESTONE_WINDOW_SECONDS + 10)).toBe(0);
  });
  it("remaining spots = cap − confirmed", () => {
    expect(remainingSpots(0)).toBe(10);
    expect(remainingSpots(10)).toBe(0);
    expect(remainingSpots(12)).toBe(0);
  });
  it("withinWindow bounds", () => {
    expect(withinWindow(LAUNCH, LAUNCH + 100)).toBe(true);
    expect(withinWindow(LAUNCH, LAUNCH + MILESTONE_WINDOW_SECONDS + 1)).toBe(false);
    expect(withinWindow(LAUNCH, LAUNCH - 1)).toBe(false);
  });
});

describe("computeStatus", () => {
  it("in_progress when window open and not both milestones met", () => {
    const r = computeStatus({ ...base, now: 500_000, volumeMilestoneReachedTs: 1100, holdersMilestoneReachedTs: null });
    expect(r.status).toBe("in_progress");
    expect(r.secondMilestoneReachedTs).toBeNull();
  });

  it("expired when window closed without both milestones", () => {
    const r = computeStatus({
      ...base,
      now: LAUNCH + MILESTONE_WINDOW_SECONDS + 100,
      volumeMilestoneReachedTs: 1100,
      holdersMilestoneReachedTs: null,
    });
    expect(r.status).toBe("expired");
  });

  it("qualified when both milestones met in-window and clean", () => {
    const r = computeStatus({ ...base, now: 500_000, volumeMilestoneReachedTs: 1100, holdersMilestoneReachedTs: 1300 });
    expect(r.status).toBe("qualified");
    expect(r.secondMilestoneReachedTs).toBe(1300); // the later of the two
    expect(r.reviewNotes).toEqual([]);
  });

  it("needs review when it only clears $50k with flagged volume", () => {
    const r = computeStatus({
      ...base,
      volumeExcludingFlaggedUsd: MILESTONE_VOLUME_USD - 1,
      now: 500_000,
      volumeMilestoneReachedTs: 1100,
      holdersMilestoneReachedTs: 1300,
    });
    expect(r.status).toBe("disqualified_candidate");
    expect(r.reviewNotes.length).toBeGreaterThan(0);
  });

  it("needs review when the creator has an earlier qualifying token", () => {
    const r = computeStatus({
      ...base,
      creatorHasEarlierQualifier: true,
      now: 500_000,
      volumeMilestoneReachedTs: 1100,
      holdersMilestoneReachedTs: 1300,
    });
    expect(r.status).toBe("disqualified_candidate");
    expect(r.reviewNotes.join(" ")).toMatch(/one entry per creator/i);
  });
});
