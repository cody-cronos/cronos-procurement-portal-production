import type { WorkbookCell, WorkbookSheet } from './customerFinancialExports'
import type { ManagedFundsFinancialReport } from './managedFundsFinancialReport.mjs'
import { validateManagedFundsFinancialReport } from './managedFundsFinancialReport.mjs'

const text = (value: string, style = 39): WorkbookCell => ({ value, style })
const money = (value: number, style = 41): WorkbookCell => ({ value: value / 100, style })
const header = (labels: string[]) => labels.map(value => text(value, 59))
const dateSerial = (date: string) => Math.floor(Date.parse(date.slice(0, 10) + 'T00:00:00Z') / 86400000) + 25569
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function purchaseDescription(description: string, references: string) {
  let result = description
  for (const reference of references.split('\n').filter(Boolean)) {
    result = result.replace(new RegExp(`(?:\\s+[-–—|,;:]\\s*|\\s+PO\\s*(?:#|No\\.?|Number)?\\s*:?[\\s]*|^)${escaped(reference)}\\s*$`, 'gi'), '')
  }
  result = result.replace(/\s*[-–—|,;:/]+\s*$/g, '').replace(/\s+(?:quote|purchase request|material request)$/i, '').replace(/\s+/g, ' ').trim()
  if (!result) return 'Funded purchase'
  // An ellipsis makes shortening explicit; never fabricate a replacement description.
  return result.length <= 180 ? result : result.slice(0, 177).replace(/\s+\S*$/, '').trim() + '…'
}

function rowHeights(rows: WorkbookCell[][], widths: number[]) {
  return Object.fromEntries(rows.map((row, index) => [index + 7, Math.min(409, Math.max(28, ...row.map((cell, col) => {
    const value = String(typeof cell === 'object' ? cell.value ?? '' : cell)
    return value.split('\n').reduce((lines, part) => lines + Math.max(1, Math.ceil(part.length / (widths[col] * .85))), 0) * 14 + 10
  })))]))
}

function reportHeader(report: ManagedFundsFinancialReport, title: string, end: string) {
  const project = `${report.projectNumber} — ${report.projectName}`
  return {
    rows: [[text('CRONOS LLC', 47)], [text(title, 48)], [], [text('Project: ' + project, 49)],
      [text(`Customer: ${report.customer}  ·  Report Date: ${report.generatedAt.slice(0, 10)}  ·  USD`, 49)]],
    merges: [`A1:${end}1`, `A2:${end}3`, `A4:${end}4`, `A5:${end}5`],
    rowHeights: { 1: 22, 2: 30, 3: 14, 4: Math.max(26, Math.ceil(project.length / 95) * 14 + 10), 5: 26, 6: 32 },
  }
}

export function managedFundsFinancialSheets(report: ManagedFundsFinancialReport): WorkbookSheet[] {
  validateManagedFundsFinancialReport(report)
  const widths = [12, 47, 27, 19, 23]
  const actions = report.actions.map((action, index) => {
    const style = index % 2 ? 40 : 39
    const status = action.status === 'Received' ? 'Processing' : action.status
    const statusStyle = status === 'Delivered' ? 64 : status === 'In Transit' ? 63 : 62
    return [text(action.actionNumber, style), text(purchaseDescription(action.description, action.purchaseOrderNumbers), style),
      text(action.purchaseOrderNumbers, style), text(status, statusStyle), money(action.committed, index % 2 ? 42 : 41)]
  })
  const lastAction = 6 + actions.length, totalRow = lastAction + 1
  const total = report.funding.authorized / 100, committed = report.funding.committed / 100, available = report.funding.available / 100
  const utilization = total ? committed / total : 0
  const project = `Project: ${report.projectNumber} — ${report.projectName}`
  const overviewRows: WorkbookCell[][] = Array.from({ length: 20 }, () => [])
  const put = (row: number, column: number, cell: WorkbookCell) => { overviewRows[row - 1][column - 1] = cell }
  put(2, 2, text('CRONOS LLC', 47))
  put(3, 2, text('MANAGED FUNDS REPORT', 48))
  put(5, 2, text('Customer: ' + report.customer, 49))
  put(6, 2, text(project, 49))
  put(7, 2, { value: dateSerial(report.generatedAt), style: 65 })
  put(7, 10, text('Currency: USD', 49))
  put(9, 2, text('TOTAL FUNDING', 50))
  put(9, 6, text('FUNDS COMMITTED', 50))
  put(9, 10, text('FUNDS AVAILABLE', 52))
  put(10, 2, money(report.funding.authorized, 51))
  put(10, 6, { formula: `'Funded Purchases'!E${totalRow}`, value: committed, style: 51 })
  put(10, 10, { formula: 'ROUND(B10-F10,2)', value: available, style: 53 })
  put(14, 2, { formula: 'IF(B10=0,"Funding Utilization — n.a.","Funding Utilization — "&TEXT(F10/B10,"0.0%")&" Committed")',
    value: total ? `Funding Utilization — ${(utilization * 100).toFixed(1)}% Committed` : 'Funding Utilization — n.a.', style: 54 })
  put(15, 2, { formula: 'IF(B10=0,0,F10/B10)', value: utilization, style: 55 })
  put(17, 2, total ? { formula: 'F10/B10', value: utilization, style: 56 } : text('Committed: n.a.', 49))
  put(17, 8, total ? { formula: 'J10/B10', value: available / total, style: 57 } : text('Available: n.a.', 49))
  put(19, 2, { formula: actions.length ? `COUNTA('Funded Purchases'!A7:A${lastAction})` : '0', value: actions.length, style: 58 })
  const overview: WorkbookSheet = {
    name: 'Funding Overview', rows: overviewRows, showGridLines: false, selected: true, zoomScale: 95,
    columnWidths: [2, 12, 12, 12, 2, 12, 12, 12, 2, 12, 12, 12, 2],
    merges: ['B2:L2', 'B3:L4', 'B5:L5', 'B6:L6', 'B7:H7', 'J7:L7', 'B9:D9', 'F9:H9', 'J9:L9', 'B10:D12', 'F10:H12', 'J10:L12',
      'B14:L14', 'B15:L16', 'B17:F17', 'H17:L17', 'B19:L19'],
    rowHeights: { 1: 12, 2: 24, 3: 28, 4: 18, 5: 24, 6: Math.max(28, Math.ceil(project.length / 100) * 14 + 10), 7: 24, 8: 14,
      9: 26, 10: 24, 11: 22, 12: 18, 13: 18, 14: 26, 15: 16, 16: 10, 17: 24, 18: 16, 19: 30, 20: 10 },
    dataBar: { range: 'B15:L16', color: '06163D', showValue: false }, landscape: true, fitToHeight: 1,
    printArea: 'A1:M20', reportTitle: `${report.projectNumber} | Managed Funds Report`,
  }
  const title = reportHeader(report, 'FUNDED PURCHASES', 'E')
  return [overview, {
    name: 'Funded Purchases', ...title, showGridLines: false, zoomScale: 95, landscape: true, reportTitle: `${report.projectNumber} | Funded Purchases`,
    rows: [...title.rows, header(['Action', 'Purchase Description', 'PO Number', 'Status', 'Customer Amount']), ...actions,
      [text('TOTAL FUNDS COMMITTED', 60), '', '', '', { formula: actions.length ? `ROUND(SUM(E7:E${lastAction}),2)` : '0', value: committed, style: 61 }]],
    columnWidths: widths, freezePane: { rows: 6 }, autoFilter: `A6:E${Math.max(6, lastAction)}`, printTitleRows: '1:6', printArea: `A1:E${totalRow}`,
    merges: [...title.merges, `A${totalRow}:D${totalRow}`], rowHeights: { ...title.rowHeights, ...rowHeights(actions, widths), [totalRow]: 34 },
  }]
}

// Reuse the same allowlisted, approved customer pricing for the separate optional export.
export function managedFundsEquipmentSheet(report: ManagedFundsFinancialReport, actionNumber?: string): WorkbookSheet {
  validateManagedFundsFinancialReport(report)
  if (actionNumber && !report.actions.some(action => action.actionNumber === actionNumber)) throw new Error('The selected funded action is unavailable. Refresh the project before exporting.')
  const lines = report.lines.filter(line => !actionNumber || line.actionNumber === actionNumber)
  if (!lines.length) throw new Error('No supported customer-approved equipment details are available for this selection.')
  const title = reportHeader(report, 'DETAILED EQUIPMENT LIST', 'G')
  const widths = [12, 25, 23, 47, 12, 24, 25]
  const details = lines.map((line, index) => {
    const style = index % 2 ? 40 : 39, numericStyle = index % 2 ? 42 : 41, row = index + 7
    return [text(line.actionNumber, style), text(line.partNumber, style), text(line.manufacturer, style), text(line.description, style),
      { value: line.quantity, style }, line.included ? text('Included', style) : money(line.unitPrice, numericStyle),
      line.included ? text('Included', style) : { formula: `ROUND(E${row}*F${row},2)`, value: line.extendedPrice / 100, style: numericStyle }]
  })
  return { name: 'Equipment List', ...title, rows: [...title.rows, header(['Action', 'Part Number', 'Manufacturer', 'Description', 'Quantity', 'Customer Unit Price', 'Customer Extended Price']), ...details],
    columnWidths: widths, showGridLines: false, selected: true, zoomScale: 95, landscape: true, reportTitle: `${report.projectNumber} | Detailed Equipment List`,
    freezePane: { rows: 6 }, autoFilter: `A6:G${6 + details.length}`, printTitleRows: '1:6', printArea: `A1:G${6 + details.length}`,
    rowHeights: { ...title.rowHeights, ...rowHeights(details, widths) },
  }
}
