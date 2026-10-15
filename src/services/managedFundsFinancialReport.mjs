import { calculateLineTotals } from './calculations.ts'
import { procurementStatus } from '../domain/managedFunds.mjs'

const approved = new Set(['Approved', 'In Progress', 'Complete', 'Cancelled'])
const fundedTypes = new Set(['Purchase Material', 'Direct Expense / Pass-Through'])
const fundingKinds = new Set(['Original Funding', 'Funding Modification', 'PM+ Funding Reconciliation'])
const invalid = message => { throw new Error(`Customer financial report cannot be generated: ${message}`) }
const integer = (value, label) => {
  if (!Number.isSafeInteger(value)) invalid(`${label} is missing or invalid. Review the saved funding records.`)
  return value
}
const sum = (rows, key) => integer(rows.reduce((n, row) => n + integer(row[key], key), 0), key)
const linked = (record, action, ids) => record.actionId ? record.actionId === action.id : (action[ids] || []).includes(record.id)
const unique = values => [...new Set(values.filter(Boolean))]
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const identity = value => String(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const supplierPattern = value => [...identity(value)].map(escaped).join('[\\s\\p{P}]*')

// These source values are used only for redaction, never copied into the report DTO.
function customerText(project, state) {
  const quoteLines = (project.quotes || []).flatMap(q => q.lines || [])
  const pos = project.purchaseOrders || []
  const suppliers = unique([...state.actions.flatMap(a => a.vendors || []), ...pos.map(p => p.vendor), ...quoteLines.map(l => l.vendor)])
    .filter(value => !['unassigned', 'cronos', 'cronosllc'].includes(identity(value)))
  const secrets = unique([...quoteLines.map(l => l.quoteNumber), ...pos.flatMap(p => [p.vendorOrderNumber, p.supplierAccountNumber]),
    ...pos.flatMap(p => (p.lines || []).map(l => l.vendorOrderNumber))])
  const manufacturers = new Set([...quoteLines, ...pos.flatMap(p => p.lines || [])].map(l => identity(l.manufacturer || '')).filter(Boolean))
  return (value, product = false) => {
    let text = String(value ?? '').replace(/[\x00-\x1f]/g, ' ')
      .replace(/\([^)]*\b(?:QBO|QuickBooks|internal|supplier account)\b[^)]*\)/gi, '')
    for (const term of [...secrets, ...suppliers.filter(s => !product || !manufacturers.has(identity(s)))].sort((a, b) => b.length - a.length)) {
      const pattern = secrets.includes(term) ? escaped(term) : supplierPattern(term)
      text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'giu'), '')
    }
    // Raw preparer notes and accounting terms have no place in customer descriptions.
    text = text.split(/\n|[.;]\s+/).filter(part => !/\b(?:supplier|distributor|vendor|acquisition|margin|markup|profit|account\s*(?:number|no\.?|#)|internal|imported|approval note|invoice\w*|payment\w*|billing|receivable|outstanding balance|customer charges|price needed|PO-TOTAL)\b/i.test(part)).join('. ')
    return text.replace(/\s+/g, ' ').replace(/\s*[-–—|,;:/]+\s*$/g, '').replace(/^\s*[-–—|,;:/]+\s*/g, '').trim()
  }
}

// Excel-only projection. Never spread a project, action, PO, quote, or transaction.
// All amounts stay in integer cents until workbook cells are constructed.
export function buildManagedFundsFinancialReport(project, state) {
  if (project.id !== state.projectId) invalid('The funding records belong to another project.')
  const actionsById = new Map(state.actions.map(a => [a.id, a]))
  if (actionsById.size !== state.actions.length || new Set(state.actions.map(a => a.number)).size !== state.actions.length) invalid('Duplicate funded action identifiers require review.')
  integer(state.originalFunding, 'Original funding')
  for (const tx of state.transactions) {
    integer(tx.authorized, 'Funding posting'); integer(tx.committed, 'Commitment posting')
    if (tx.authorized && !fundingKinds.has(tx.kind)) invalid('An unsupported funding posting requires review.')
    if (tx.authorized && tx.actionId && (!actionsById.has(tx.actionId) || !approved.has(actionsById.get(tx.actionId).status))) invalid('A funding adjustment is not approved.')
    if (tx.committed && (!actionsById.has(tx.actionId) || !fundedTypes.has(actionsById.get(tx.actionId).type) || !approved.has(actionsById.get(tx.actionId).status))) invalid('A commitment has no approved funded action.')
  }
  const original = sum(state.transactions.filter(t => t.kind === 'Original Funding'), 'authorized')
  if (original !== state.originalFunding) invalid('Original funding does not reconcile to the funding ledger.')
  const modifications = sum(state.transactions.filter(t => t.kind !== 'Original Funding'), 'authorized')
  const authorized = integer(original + modifications, 'Total authorized funding')
  if (original < 0 || authorized < 0) invalid('Authorized funding is negative.')
  const clean = customerText(project, state), register = [], details = []
  let omittedDetails = false
  for (const action of state.actions.filter(a => fundedTypes.has(a.type) && approved.has(a.status)).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))) {
    const postings = state.transactions.filter(t => t.actionId === action.id)
    const committed = sum(postings, 'committed')
    if (committed < 0) invalid(`${action.number} has a negative net commitment.`)
    integer(action.authorizedAmount, `${action.number} authorization`)
    if (committed > action.authorizedAmount) invalid(`${action.number} exceeds its approved allocation.`)
    if (action.status === 'Cancelled' && committed === 0) continue
    if (!postings.some(t => ['Commitment', 'Quote Approval', 'Legacy Quote Mapping', 'Legacy PO Mapping'].includes(t.kind))) invalid(`${action.number} has no saved commitment approval.`)
    const quotes = (project.quotes || []).filter(q => linked(q, action, 'quoteIds') && q.status === 'Customer Approved')
    const pos = (project.purchaseOrders || []).filter(p => linked(p, action, 'poIds'))
    // The old migration sometimes copied supplier cost into the allocation. Require
    // explicit customer pricing for those records rather than endorsing that fallback.
    if (postings.some(t => t.kind === 'Legacy PO Mapping') && pos.some(p => typeof p.customerTotalCost !== 'number' || !Number.isFinite(p.customerTotalCost) || p.customerTotalCost < 0)) invalid(`${action.number} needs a verified customer commitment.`)
    if (postings.some(t => t.kind === 'Legacy Quote Mapping') && !quotes.length && committed > 0) invalid(`${action.number} needs customer approval of its pricing.`)
    const activePos = pos.filter(p => p.status !== 'Cancelled')
    const status = action.status === 'Cancelled' || (pos.length && !activePos.length) ? 'Cancelled' : procurementStatus({ ...project, purchaseOrders: activePos }, action)
    const notes = unique(activePos.flatMap(p => [clean(p.customerUpdateNotes), ...(p.lines || []).map(l => clean(l.customerNote))]))
    if (action.status === 'Cancelled' && committed > 0) notes.push('Remaining approved commitment has not been released.')
    // The purchase description is the saved ledger label, including vendor names
    // deliberately entered there. Other report fields retain their redaction rules.
    register.push({ actionNumber: clean(action.number), description: action.description,
      quoteNumbers: unique(quotes.map(q => clean(q.quoteNumber))).join('\n'), purchaseOrderNumbers: unique(pos.map(p => clean(p.poNumber))).join('\n'),
      status, committed, notes: notes.join('\n') })
    if (action.status === 'Cancelled' || committed === 0) continue
    for (const quote of quotes) {
      const priced = []
      for (const line of quote.lines || []) {
        const numeric = value => typeof value === 'number' && Number.isFinite(value)
        const ordered = activePos.filter(p => p.quoteId === quote.id).flatMap(p => p.lines || []).filter(item => {
          if (item.status === 'Cancelled') return false
          if (item.quoteLineId) return item.quoteLineId === line.id
          if (item.id === line.id || item.id === `po-${line.id}`) return true
          // Older POs lack quoteLineId. A unique product identity is a safe join;
          // ambiguous duplicate parts cannot establish the ordered quantity.
          return line.partNumber && identity(item.partNumber) === identity(line.partNumber)
            && (quote.lines || []).filter(l => identity(l.partNumber) === identity(line.partNumber)).length === 1
        })
        const quantity = ordered.reduce((n, item) => n + item.quantityOrdered, 0)
        if (!ordered.length || !ordered.every(item => numeric(item.quantityOrdered) && item.quantityOrdered >= 0) || !numeric(quantity) || quantity <= 0) { omittedDetails = true; continue }
        if (!numeric(line.quantity) || line.quantity <= 0 || !numeric(line.unitCost) || line.unitCost < 0
          || (line.markupPercent != null && (!numeric(line.markupPercent) || line.markupPercent < 0))
          || (line.pricingMode === 'margin' && (!numeric(line.marginPercent) || line.marginPercent < 0 || line.marginPercent >= 100))
          || (line.noCost && line.unitCost !== 0)) { omittedDetails = true; continue }
        const pricing = calculateLineTotals({ ...line, quantity })
        const unitPrice = Math.round(pricing.sellPrice * 100), extendedPrice = Math.round(pricing.extendedSellPrice * 100)
        if (!Number.isSafeInteger(unitPrice) || !Number.isSafeInteger(extendedPrice)) { omittedDetails = true; continue }
        priced.push({ actionNumber: clean(action.number), partNumber: clean(line.partNumber, true), manufacturer: clean(line.manufacturer, true),
          description: clean(line.description, true) || 'Equipment or service', quantity, unitPrice, extendedPrice })
      }
      for (const line of priced) {
        const included = line.unitPrice === 0 && priced.some(l => l.unitPrice > 0)
        details.push({ ...line, description: line.description + (included ? ' (included in priced configuration)' : ''), included })
      }
    }
    if (!quotes.length && activePos.some(p => (p.lines || []).length)) omittedDetails = true
  }
  const committed = sum(register, 'committed')
  if (committed !== sum(state.transactions, 'committed')) invalid('The purchase register does not reconcile to the commitment ledger.')
  return { customer: clean(project.customer), projectNumber: clean(project.projectNumber), projectName: clean(project.projectName, true),
    generatedAt: new Date().toISOString(), funding: { original, modifications, authorized, committed, available: integer(authorized - committed, 'Available balance') },
    actions: register, lines: details, notes: [
      'Commitments are approved customer allocations, net of saved adjustments and releases. Each funded action is counted once.',
      'Equipment and service details support the register and are not additional commitments.',
      ...(omittedDetails ? ['Some equipment details are omitted because approved item quantities or customer unit prices are unavailable. The approved action allocations remain in the register.'] : []),
      ...(authorized - committed < 0 ? ['Approved commitments exceed authorized funding. The remaining available balance is negative.'] : []),
    ] }
}

export function validateManagedFundsFinancialReport(report) {
  const f = report.funding
  for (const [key, value] of Object.entries(f)) integer(value, key)
  if (f.original + f.modifications !== f.authorized || f.authorized - f.committed !== f.available || sum(report.actions, 'committed') !== f.committed
    || new Set(report.actions.map(a => a.actionNumber)).size !== report.actions.length) invalid('The report totals cannot be reconciled.')
}
