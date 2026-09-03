import { calendarDaysBetween } from "../dates";
import type { MaximumDrawdown, NavPoint } from "../types";
import { finiteOrUndefined } from "../validation";

export function maximumDrawdown(
  nav: readonly NavPoint[],
): MaximumDrawdown | undefined {
  if (nav.length < 2) return undefined;

  let peak = nav[0];
  if (!peak || !(peak.nav > 0)) return undefined;

  let worst: {
    drawdown: number;
    peak: NavPoint;
    trough: NavPoint;
  } | undefined;
  let recoveredFromWorst: NavPoint | undefined;

  for (const point of nav) {
    if (!(point.nav > 0)) continue;
    if (point.nav >= peak.nav) {
      peak = point;
      continue;
    }
    const drawdown = finiteOrUndefined((point.nav / peak.nav - 1) * 100);
    if (drawdown === undefined) continue;
    if (!worst || drawdown < worst.drawdown) {
      worst = { drawdown, peak, trough: point };
      recoveredFromWorst = undefined;
    }
  }

  if (!worst) {
    const first = nav[0];
    const last = nav[nav.length - 1];
    if (!first || !last) return undefined;
    return {
      drawdown: 0,
      peakDate: first.date,
      peakNav: first.nav,
      troughDate: first.date,
      troughNav: first.nav,
      recovered: true,
      recoveryDate: first.date,
      recoveryDays: 0,
    };
  }

  for (const point of nav) {
    if (point.date <= worst.trough.date) continue;
    if (point.nav >= worst.peak.nav) {
      recoveredFromWorst = point;
      break;
    }
  }

  return {
    drawdown: worst.drawdown,
    peakDate: worst.peak.date,
    peakNav: worst.peak.nav,
    troughDate: worst.trough.date,
    troughNav: worst.trough.nav,
    recovered: recoveredFromWorst !== undefined,
    ...(recoveredFromWorst
      ? {
          recoveryDate: recoveredFromWorst.date,
          recoveryDays: calendarDaysBetween(
            worst.trough.date,
            recoveredFromWorst.date,
          ),
        }
      : {}),
  };
}
