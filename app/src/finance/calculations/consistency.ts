import type {
  ConsistencyMetrics,
  RollingReturnStatistics,
} from "../types";

export function consistencyMetrics(input: {
  readonly threeYear?: RollingReturnStatistics;
  readonly fiveYear?: RollingReturnStatistics;
}): ConsistencyMetrics {
  const insufficientHistory: string[] = [];
  const threeYear = usable(input.threeYear) ? input.threeYear : undefined;
  const fiveYear = usable(input.fiveYear) ? input.fiveYear : undefined;
  if (!threeYear) insufficientHistory.push("3Y rolling returns");
  if (!fiveYear) insufficientHistory.push("5Y rolling returns");

  return {
    ...(threeYear
      ? {
          positiveThreeYearRollingPercentage:
            threeYear.positivePeriodPercentage,
          threeYearAbove10PercentPercentage: threeYear.above10PercentPercentage,
          threeYearAbove12PercentPercentage: threeYear.above12PercentPercentage,
          threeYearRollingStandardDeviation: threeYear.standardDeviation,
          ...(threeYear.worstPeriod
            ? { worstThreeYearRollingReturn: threeYear.worstPeriod.return }
            : {}),
        }
      : {}),
    ...(fiveYear
      ? {
          positiveFiveYearRollingPercentage: fiveYear.positivePeriodPercentage,
          fiveYearAbove10PercentPercentage: fiveYear.above10PercentPercentage,
          fiveYearAbove12PercentPercentage: fiveYear.above12PercentPercentage,
          fiveYearRollingStandardDeviation: fiveYear.standardDeviation,
          ...(fiveYear.worstPeriod
            ? { worstFiveYearRollingReturn: fiveYear.worstPeriod.return }
            : {}),
        }
      : {}),
    insufficientHistory,
  };
}

function usable(
  stats: RollingReturnStatistics | undefined,
): stats is RollingReturnStatistics {
  return stats !== undefined && !stats.insufficientHistory && stats.observations > 0;
}
