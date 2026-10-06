// Pattern statistics + machine-time estimate. Counting conventions follow
// libembroidery's pattern.c helpers (embp_realStitches, emb_total_thread_length)
// - real stitches are needle penetrations only; thread length is the flat
// stitched path length (actual consumption runs higher with loft + bobbin).

import { CMD, colorBlocks, patternBounds, type ParsedPattern } from "./pattern";

export type MachineParams = {
  stitchesPerMinute: number;
  secondsPerColorChange: number;
  /** Industry figure: a trim costs ≈120 stitches of time (~11s at 650spm). */
  secondsPerTrim: number;
  setupMinutes: number;
  /** Garment + backing thickness - drives thread consumption. Default 0.8mm. */
  fabricThicknessMm?: number;
};

export const DEFAULT_MACHINE: MachineParams = {
  stitchesPerMinute: 650,
  secondsPerColorChange: 30,
  secondsPerTrim: 11,
  setupMinutes: 5,
  fabricThicknessMm: 0.8,
};

/**
 * Machines auto-slow when the frame must travel far per stitch: full speed up
 * to ~3mm, derating linearly to ~55% at 7mm+ (vendor firmware curves are
 * unpublished - this is the practitioner-consensus shape; wide satins run at
 * less than half speed).
 */
function speedFactor(moveLenMm: number): number {
  if (moveLenMm <= 3) return 1;
  if (moveLenMm >= 7) return 0.55;
  return 1 - 0.45 * ((moveLenMm - 3) / 4);
}

export type PatternStats = {
  totalRecords: number;
  realStitches: number;
  jumps: number;
  explicitTrims: number;
  inferredTrims: number;
  colorChanges: number;
  colorBlockCount: number;
  widthMm: number;
  heightMm: number;
  stitchPathM: number; // needle-down path length, meters
  travelPathM: number; // jump/travel length, meters
  /**
   * Estimated needle-thread consumption (A&E-style model: path length plus
   * 2× fabric thickness per penetration). Matches the industry 5–6m/1000st
   * band at typical stitch lengths. Add 10–15% waste when planning cones.
   */
  needleThreadM: number;
  bobbinThreadM: number; // ≈0.45 × needle (correct tension shows ⅓ bobbin on back)
  effectiveSpm: number; // speed after long-move derating
  avgStitchMm: number;
  maxStitchMm: number;
  stitchesPerMm2: number; // real stitches / bounding-box area
  runtimeMinutes: number;
  runtimeBreakdown: { stitching: number; colorChanges: number; trims: number; setup: number };
};

export function computeStats(
  pattern: ParsedPattern,
  machine: MachineParams = DEFAULT_MACHINE,
): PatternStats {
  const s = pattern.stitches;
  let realStitches = 0;
  let jumps = 0;
  let explicitTrims = 0;
  let colorChanges = 0;
  let stitchPath = 0; // 0.1 mm units
  let travelPath = 0;
  let maxStitch = 0;
  let jumpRun = 0;
  let inferredTrims = 0;

  let stitchingMinutes = 0;
  const spm = Math.max(1, machine.stitchesPerMinute);
  let px: number | null = null;
  let py: number | null = null;
  for (const st of s) {
    const dist = px === null || py === null ? 0 : Math.hypot(st.x - px, st.y - py);
    switch (st.cmd) {
      case CMD.STITCH:
        realStitches++;
        stitchPath += dist;
        stitchingMinutes += 1 / (spm * speedFactor(dist / 10));
        if (dist > maxStitch) maxStitch = dist;
        if (jumpRun >= 3) inferredTrims++;
        jumpRun = 0;
        break;
      case CMD.JUMP:
      case CMD.SEQUIN_EJECT:
        jumps++;
        travelPath += dist;
        jumpRun++;
        break;
      case CMD.TRIM:
        explicitTrims++;
        jumpRun = 0;
        break;
      case CMD.COLOR_CHANGE:
      case CMD.STOP:
        colorChanges++;
        jumpRun = 0;
        break;
      default:
        break;
    }
    if (st.cmd !== CMD.END) {
      px = st.x;
      py = st.y;
    }
  }

  const b = patternBounds(s);
  const widthMm = (b.maxX - b.minX) / 10;
  const heightMm = (b.maxY - b.minY) / 10;
  const areaMm2 = widthMm * heightMm;

  // DST has no trim opcode - machines trim on jump runs. Only surface the
  // inference when the file carries no explicit trims.
  const trims = explicitTrims > 0 ? explicitTrims : inferredTrims;

  const stitchingMin = stitchingMinutes;
  const colorMin = (colorChanges * machine.secondsPerColorChange) / 60;
  const trimMin = (trims * machine.secondsPerTrim) / 60;
  const setupMin = machine.setupMinutes;

  const thicknessMm = machine.fabricThicknessMm ?? 0.8;
  const stitchPathMeters = stitchPath / 10 / 1000;
  const needleThreadM = stitchPathMeters + (realStitches * 2 * thicknessMm) / 1000;
  const bobbinThreadM = needleThreadM * 0.45;

  return {
    totalRecords: s.length,
    realStitches,
    jumps,
    explicitTrims,
    inferredTrims,
    colorChanges,
    colorBlockCount: colorBlocks(pattern).length,
    widthMm,
    heightMm,
    stitchPathM: stitchPathMeters,
    travelPathM: travelPath / 10 / 1000,
    needleThreadM,
    bobbinThreadM,
    effectiveSpm: stitchingMin > 0 ? realStitches / stitchingMin : spm,
    avgStitchMm: realStitches > 0 ? stitchPath / realStitches / 10 : 0,
    maxStitchMm: maxStitch / 10,
    stitchesPerMm2: areaMm2 > 0 ? realStitches / areaMm2 : 0,
    runtimeMinutes: stitchingMin + colorMin + trimMin + setupMin,
    runtimeBreakdown: {
      stitching: stitchingMin,
      colorChanges: colorMin,
      trims: trimMin,
      setup: setupMin,
    },
  };
}
