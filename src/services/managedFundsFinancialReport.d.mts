import type { Project } from '../types'
import type { FundsState } from '../domain/managedFunds.mjs'
export type ManagedFundsFinancialReport = {
  customer: string; projectNumber: string; projectName: string; generatedAt: string;
  funding: { original: number; modifications: number; authorized: number; committed: number; available: number };
  actions: { actionNumber: string; description: string; quoteNumbers: string; purchaseOrderNumbers: string; status: string; committed: number; notes: string }[];
  lines: { actionNumber: string; partNumber: string; manufacturer: string; description: string; quantity: number; unitPrice: number; extendedPrice: number; included: boolean }[];
  notes: string[];
}
export function buildManagedFundsFinancialReport(project: Project, state: FundsState): ManagedFundsFinancialReport
export function validateManagedFundsFinancialReport(report: ManagedFundsFinancialReport): void
