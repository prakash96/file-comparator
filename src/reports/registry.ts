import type { ReportKind } from '../models/session';
import { CSV_REPORTS } from './csvReport';
import { excelReport } from './excelReport';
import { htmlReport } from './htmlReport';
import { jsonSummaryReport } from './jsonSummary';
import type { ReportGenerator } from './types';

export const REPORTS: ReportGenerator[] = [...CSV_REPORTS, excelReport, htmlReport, jsonSummaryReport];

export function getReport(kind: ReportKind): ReportGenerator {
  const r = REPORTS.find((x) => x.kind === kind);
  if (!r) throw new Error(`Unknown report kind ${kind}`);
  return r;
}
