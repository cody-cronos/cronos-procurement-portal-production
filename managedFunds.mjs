// Shared by the API and UI. All persisted amounts are integer USD cents.
export const ACTION_TYPES = ['Purchase Material', 'Direct Expense / Pass-Through', 'Create Customer Invoice', 'Credit / Adjustment', 'Funding Modification']
export const ACTION_STATUSES = ['Draft', 'Pending Approval', 'Approved', 'In Progress', 'Complete', 'Cancelled']
export const BILLING_STATUSES = ['Not Ready to Bill', 'Ready to Bill', 'Draft Invoice', 'Invoiced', 'Paid', 'Credited']
const ordinary = ['view', 'create', 'edit', 'approve', 'issue_po', 'expense', 'invoice', 'cancel']
export const MF_PERMISSIONS = { admin: ['*'], procurement: ordinary, sales: ['view', 'create', 'edit', 'invoice'], engineering: ['view'] }
export function canManageFunds(actor, permission) {
  const role = String(actor?.role || '').toLowerCase().replace('procurement team', 'procurement')
  const extra = actor?.permissions instanceof Set ? [...actor.permissions] : actor?.permissions || []
  return (MF_PERMISSIONS[role] || []).includes('*') || (MF_PERMISSIONS[role] || []).includes(permission) || extra.includes(`atlas.managed_funds.${permission}`) || extra.includes('*')
}
function requirePermission(actor, permission) {
  if (!actor?.id || !canManageFunds(actor, permission)) fail(`Permission required: atlas.managed_funds.${permission}`, 403)
}
function fail(message, status = 400, details) { const error = new Error(message); error.status = status; error.details = details; throw error }
export function cents(value) {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) fail('Enter a valid monetary amount.')
  const result = Math.round(Number(value) * 100)
  if (!Number.isSafeInteger(result) || Math.abs(result) > 100_000_000_000_000) fail('Monetary amount is out of range.')
  return result
}
function amount(value, signed = false) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 100_000_000_000_000 || (!signed && value < 0)) fail('Amount must be valid integer cents.')
  return value
}
function required(value, label) { const text = String(value ?? '').trim(); if (!text || text.length > 10000) fail(`${label} is required (maximum 10,000 characters).`); return text }
function date(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('A valid date is required.'); return value }
const clone = value => JSON.parse(JSON.stringify(value))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
export function isManagedFunds(project) { return ['Managed Funds', 'Checkbook'].includes(project?.projectType) }
export function financialSummary(state, actionId) {
  const out = { authorized: 0, committed: 0, actualCost: 0, billAmount: 0, invoiced: 0, paid: 0, available: 0, unbilled: 0 }
  for (const tx of state?.transactions || []) {
    if (actionId && tx.actionId !== actionId && tx.adjustmentActionId !== actionId) continue
    for (const field of ['authorized', 'committed', 'actualCost', 'billAmount', 'invoiced', 'paid']) out[field] += tx[field] || 0
  }
  for (const field of ['authorized', 'committed', 'actualCost', 'billAmount', 'invoiced', 'paid']) amount(out[field], true)
  out.available = out.authorized - out.committed
  out.unbilled = out.authorized - out.invoiced
  return out
}
export function actionFinancials(state, actionId) {
  const totals = financialSummary(state, actionId)
  const reserved = state.invoices.filter(i => i.status === 'Draft').flatMap(i => i.allocations).filter(a => a.actionId === actionId).reduce((n, a) => n + a.amount, 0)
  return { ...totals, draftReserved: reserved, billable: Math.min(totals.billAmount,totals.committed) - totals.invoiced - reserved, variance: totals.committed - totals.invoiced }
}
export function billingStatus(state, action) {
  const t = actionFinancials(state, action.id)
  if (state.transactions.some(t => t.actionId === action.id && t.kind === 'Customer Credit') && t.invoiced <= 0) return 'Credited'
  if (t.invoiced > 0 && t.paid >= t.invoiced && t.billable <= 0) return 'Paid'
  if (t.draftReserved > 0) return 'Draft Invoice'
  if (t.invoiced > 0 && t.billable <= 0) return 'Invoiced'
  return action.readyToBill ? 'Ready to Bill' : 'Not Ready to Bill'
}
export function procurementStatus(project, action) {
  const pos = (project.purchaseOrders || []).filter(po => po.actionId === action.id || action.poIds.includes(po.id))
  if (!pos.length) return 'Processing'
  const lines = pos.flatMap(po => (po.lines || []).map(l => ({ ...l, poId: po.id })))
  const shipments = (project.materialShipments || []).filter(s => pos.some(po => po.id === s.poId))
  if (lines.length && lines.every(l => l.status === 'Delivered' || shipments.filter(s => s.poId === l.poId).flatMap(s => s.lines).filter(s => s.melLineItemId === l.id).reduce((n, s) => n + (s.quantityDelivered || 0), 0) >= l.quantityOrdered)) return 'Delivered'
  if (lines.length && lines.every(l => l.quantityReceived >= l.quantityOrdered)) return 'Received'
  if (shipments.length || lines.some(l => /Transit|Shipped/.test(l.status))) return 'In Transit'
  return pos.every(po=>po.status==='PO Generated') ? 'Processing' : 'PO Issued'
}
function newAction(state, input, ctx) {
  if (!ACTION_TYPES.includes(input.type)) fail('Choose a valid Action Type.')
  const action = {
    id: ctx.id(), number: `MF-${String(state.nextAction++).padStart(3, '0')}`, projectId: state.projectId,
    type: input.type, description: required(input.description, 'Description'), requestDate: date(input.requestDate || ctx.now.slice(0, 10)),
    requestor: String(input.requestor || ''), ownerId: String(input.ownerId || ctx.actor.id), ownerName: String(input.ownerName || ctx.actor.name || ''),
    status: 'Draft', authorizedAmount: amount(input.authorizedAmount ?? 0), estimatedCost: amount(input.estimatedCost ?? 0), readyToBill: false,
    vendors: [...new Set((input.vendors || []).map(String))], quoteIds: [], poIds: [], notes: String(input.notes || ''), createdAt: ctx.now,
  }
  state.actions.push(action)
  return action
}
function post(state, ctx, input) {
  const tx = { id: ctx.id(), projectId: state.projectId, occurredAt: ctx.now, userId: ctx.actor.id, userName: ctx.actor.name || ctx.actor.email || ctx.actor.id, authorized: 0, committed: 0, actualCost: 0, billAmount: 0, invoiced: 0, paid: 0, ...input }
  for (const field of ['authorized', 'committed', 'actualCost', 'billAmount', 'invoiced', 'paid']) amount(tx[field], true)
  const previous = financialSummary(state)
  state.transactions.push(tx)
  audit(state, ctx, tx.kind, tx.id, previous, financialSummary(state), tx.reason || '')
  return tx
}
function audit(state, ctx, operation, targetId, previous, next, reason = '') {
  state.audit.push({ id: ctx.id(), occurredAt: ctx.now, userId: ctx.actor.id, userName: ctx.actor.name || ctx.actor.email || ctx.actor.id, operation, targetId, previous: clone(previous), next: clone(next), reason })
}
function fundingCheck(state, ctx, delta, fundingDelta = 0, reason = '') {
  const t = financialSummary(state)
  const remaining = t.authorized + fundingDelta - t.committed - delta
  if (remaining >= 0 || (delta <= 0 && fundingDelta >= 0)) return
  const details = { authorizedFunding: t.authorized, currentCommitments: t.committed, proposedCommitment: delta, fundingChange: fundingDelta, projectedRemainingBalance: remaining }
  if (!canManageFunds(ctx.actor, 'override') || !String(reason).trim()) fail('Insufficient Available Funding', 409, details)
  audit(state, ctx, 'Funding limit override', state.projectId, t, details, required(reason, 'Override explanation'))
}
export function initializeManagedFunds(project, actor, options = {}) {
  if (!isManagedFunds(project)) fail('This project is not a Managed Funds project.')
  const ctx = { actor, now: options.now || new Date().toISOString(), id: options.id || (() => crypto.randomUUID()) }
  const state = { schemaVersion: 1, projectId: project.id, revision: 0, nextAction: 1, nextInvoice: 1, actions: [], transactions: [], invoices: [], documents: [], audit: [], review: [], commands: [], originalFunding: cents(project.checkbookStartingBalance || 0) }
  if (state.originalFunding < 0) fail('Original funding cannot be negative.')
  post(state, ctx, { kind: 'Original Funding', authorized: state.originalFunding, reason: 'Original customer funding; source field preserved.' })
  const migrated = clone(project)
  migrated.projectType = 'Managed Funds'
  const quotes = migrated.quotes || []
  const pos = migrated.purchaseOrders || []
  const review = (recordType, recordId, reason) => state.review.push({ id: ctx.id(), recordType, recordId, reason, resolved: false })
  for (const quote of quotes) {
    const action = newAction(state, { type: 'Purchase Material', description: quote.quoteName || quote.quoteNumber || 'Legacy material request', requestor: project.customer, requestDate: (quote.createdAt || ctx.now).slice(0, 10) }, ctx)
    action.quoteIds.push(quote.id); quote.actionId = action.id; quote.actionNumber = action.number
    const linked = pos.filter(po => po.quoteId === quote.id)
    action.poIds = linked.map(po => po.id)
    linked.forEach(po => { po.actionId = action.id; po.actionNumber = action.number })
    action.vendors = [...new Set(linked.map(po => po.vendor).filter(Boolean))]
    const sell = quoteCustomerTotal(quote)
    if ((quote.lines || []).some(l => !l.unitCost || !l.quantity)) review('quote',quote.id,'Legacy quote has incomplete quantity or pricing. Confirm customer commitment from source documents.')
    action.authorizedAmount = sell
    action.estimatedCost = linked.reduce((n, po) => n + cents(po.totalCost || 0), 0)
    action.status = linked.length ? 'In Progress' : quote.status === 'Customer Approved' ? 'Approved' : 'Draft'
    post(state, ctx, { kind: 'Legacy Quote Mapping', actionId: action.id, billAmount: sell, committed: ['Approved', 'In Progress'].includes(action.status) ? sell : 0, reason: 'Existing quote and PO links retained.' })
    if (linked.length) review('action', action.id, 'Verify historical incurred costs and customer invoices. Purchase orders do not establish either balance.')
  }
  for (const po of pos.filter(po => !po.actionId)) {
    const action = newAction(state, { type: 'Purchase Material', description: po.description || po.poNumber || 'Legacy purchase order', requestor: po.requestor || project.customer }, ctx)
    action.poIds.push(po.id); action.vendors = [po.vendor].filter(Boolean); action.status = po.status === 'Cancelled' ? 'Cancelled' : 'In Progress'
    po.actionId = action.id; po.actionNumber = action.number
    const sell = cents(po.customerTotalCost ?? po.totalCost ?? 0)
    action.authorizedAmount = sell; action.estimatedCost = cents(po.totalCost || 0)
    post(state, ctx, { kind: 'Legacy PO Mapping', actionId: action.id, committed: action.status === 'Cancelled' ? 0 : sell, billAmount: sell, reason: 'Legacy PO retained; customer amount uses legacy value or cost fallback pending review.' })
    review('purchaseOrder', po.id, 'Confirm customer commitment, actual cost, and billing from source documents; no invoice or cost posting was inferred.')
  }
  for (const key of Object.keys(project)) {
    if (/invoice|document|credit|adjustment|transaction|balance/i.test(key) && key !== 'checkbookStartingBalance' && project[key] && (!Array.isArray(project[key]) || project[key].length)) review(key, project.id, 'Legacy source field retained in the project and migration backup; requires explicit financial reconciliation.')
  }
  if (financialSummary(state).available < 0) review('funding', project.id, 'Legacy commitments exceed funding. Existing amounts retained; new increases require an authorized override or funding modification.')
  audit(state, ctx, 'Initialize Managed Funds', project.id, { type: project.projectType, originalFunding: project.checkbookStartingBalance }, { type: 'Managed Funds', actions: state.actions.length, originalFunding: state.originalFunding }, 'Non-destructive migration; original records retained.')
  return { state, project: migrated }
}
export function quoteCustomerTotal(quote) {
  let total = 0
  for (const line of quote.lines || []) {
    if (!Number.isFinite(Number(line.quantity ?? 0)) || Number(line.quantity ?? 0) < 0 || !Number.isFinite(Number(line.unitCost ?? 0)) || Number(line.unitCost ?? 0) < 0 || (line.pricingMode === 'margin' && (line.marginPercent < 0 || line.marginPercent >= 100))) fail('Invalid quote quantity, cost, or margin.')
    const markup = line.pricingMode === 'margin' && line.marginPercent !== undefined ? Math.round((line.marginPercent / (100 - line.marginPercent)) * 10000) / 100 : line.markupPercent || 0
    const unit = cents(Number(line.unitCost || 0) * (1 + markup / 100))
    total += Math.round(unit * Number(line.quantity || 0))
  }
  total += cents(quote.shippingCost || 0)
  if (quote.contractFeeEnabled) total += Math.round(total / .889 - total)
  return amount(total)
}
export function applyManagedFundsCommand(source, command, actor, options = {}) {
  requirePermission(actor, 'view')
  const commandId = required(command.id, 'Command ID')
  const prior = source.commands.find(c => c.id === commandId)
  if (prior) { if (prior.userId !== actor.id || prior.payload !== JSON.stringify(command)) fail('Command ID was already used for another request.', 409); return clone(source) }
  const state = clone(source)
  const ctx = { actor, now: options.now || new Date().toISOString(), id: options.id || (() => crypto.randomUUID()) }
  const input = command.input || {}
  const action = command.actionId ? state.actions.find(a => a.id === command.actionId) : null
  if (command.actionId && !action) fail('Action not found.', 404)
  const before = clone(action || financialSummary(state))
  const active = () => { if (!action || ['Cancelled', 'Complete'].includes(action.status)) fail('Select an open Action.') }
  switch (command.type) {
    case 'create': {
      requirePermission(actor, 'create')
      if (input.type === 'Funding Modification') requirePermission(actor, 'funding')
      if (input.type === 'Credit / Adjustment') requirePermission(actor, 'adjust')
      const created = newAction(state, input, ctx)
      post(state, ctx, { kind: 'Action Created', actionId: created.id, billAmount: amount(input.billAmount || 0) })
      audit(state, ctx, 'Create Action', created.id, null, created)
      break
    }
    case 'edit': {
      requirePermission(actor, 'edit'); active()
      for (const key of ['description', 'requestor', 'ownerId', 'ownerName', 'notes']) if (input[key] !== undefined) action[key] = key === 'description' ? required(input[key], 'Description') : String(input[key])
      if (input.requestDate) action.requestDate = date(input.requestDate)
      if (input.vendors) action.vendors = [...new Set(input.vendors.map(String))]
      if ((input.estimatedCost !== undefined && input.estimatedCost !== action.estimatedCost) || (input.authorizedAmount !== undefined && input.authorizedAmount !== action.authorizedAmount) || (input.billAmount !== undefined && input.billAmount !== actionFinancials(state, action.id).billAmount)) {
        if (!['Draft', 'Pending Approval'].includes(action.status)) requirePermission(actor, 'approve')
        required(input.reason, 'Reason for financial change')
        if (input.authorizedAmount !== undefined) { const n = amount(input.authorizedAmount); if (n < actionFinancials(state, action.id).committed) fail('Authorization cannot be below existing commitments.'); action.authorizedAmount = n }
        if (input.estimatedCost !== undefined) action.estimatedCost = amount(input.estimatedCost)
        if (input.billAmount !== undefined) {
          const t = actionFinancials(state, action.id); const target = amount(input.billAmount)
          if (target < t.invoiced + t.draftReserved) fail('Bill amount cannot be reduced below issued and reserved billing.')
          post(state, ctx, { kind: 'Bill Amount Change', actionId: action.id, billAmount: target - t.billAmount, reason: input.reason })
        }
      }
      break
    }
    case 'status': {
      requirePermission(actor, 'edit'); active()
      if (!['Pending Approval', 'In Progress', 'Complete'].includes(input.status)) fail('Use approval or cancellation for this status transition.')
      const transitions = { Draft: ['Pending Approval'], 'Pending Approval': [], Approved: ['In Progress', 'Complete'], 'In Progress': ['Complete'] }
      if (!transitions[action.status]?.includes(input.status)) fail('Invalid Action status transition.')
      action.status = input.status; break
    }
    case 'approve': {
      requirePermission(actor, 'approve'); active()
      if (!['Purchase Material', 'Direct Expense / Pass-Through', 'Create Customer Invoice'].includes(action.type)) fail('Use the dedicated financial posting for this Action Type.')
      const target = amount(input.commitment); const t = actionFinancials(state, action.id)
      const approvedQuotes = (options.project?.quotes || []).filter(q => q.actionId === action.id && q.status === 'Customer Approved').reduce((n,q) => n + quoteCustomerTotal(q),0)
      if (target < approvedQuotes) fail('Commitment cannot be below approved quotes; use an authorized adjustment for a correction.')
      if (target > action.authorizedAmount) fail('Commitment exceeds the Action authorized amount.')
      if (target < t.invoiced + t.draftReserved) fail('Commitment cannot be below existing customer billing.')
      fundingCheck(state, ctx, target - t.committed, 0, input.overrideReason)
      post(state, ctx, { kind: 'Commitment', actionId: action.id, committed: target - t.committed, reason: required(input.reason, 'Approval reason') })
      if (['Draft', 'Pending Approval'].includes(action.status)) action.status = 'Approved'
      break
    }
    case 'cancel': {
      requirePermission(actor, 'cancel'); active(); const t = actionFinancials(state, action.id)
      if (t.actualCost || t.invoiced || t.draftReserved || action.poIds.length) fail('Actions with POs, costs, or billing must be corrected and completed; their history cannot be cancelled away.')
      post(state, ctx, { kind: 'Cancellation', actionId: action.id, committed: -t.committed, reason: required(input.reason, 'Cancellation reason') }); action.status = 'Cancelled'; break
    }
    case 'expense': {
      requirePermission(actor, 'expense')
      if (!action || !['Approved', 'In Progress', 'Complete'].includes(action.status) || !['Purchase Material', 'Direct Expense / Pass-Through'].includes(action.type)) fail('Approve the material or expense Action before recording cost.')
      const cost = amount(input.actualCost); if (!cost) fail('Actual cost must be greater than zero.')
      const vendor = required(input.vendor, 'Vendor'); const reference = required(input.vendorInvoiceNumber, 'Vendor invoice number')
      if (state.transactions.some(t => t.kind === 'Expense' && t.vendor?.toLowerCase() === vendor.toLowerCase() && t.reference?.toLowerCase() === reference.toLowerCase())) fail('This vendor invoice is already recorded. Use an adjustment for corrections.', 409)
      if (input.documentId && !state.documents.some(d => d.id === input.documentId && d.actionId === action.id)) fail('Supporting document must belong to this Action.')
      const t = actionFinancials(state, action.id); const bill = amount(input.billAmount || 0)
      if (t.actualCost + cost > t.committed) fail('Incurred cost exceeds the Action commitment. Increase the authorized amount and approve the additional commitment first.',409)
      if (bill > t.billAmount) fail('Update the Action bill amount before recording this expense.')
      post(state, ctx, { kind: 'Expense', actionId: action.id, actualCost: cost, customerBillAmount: bill, vendor, reference, expenseDate: date(input.expenseDate), description: required(input.description, 'Expense description'), documentId: input.documentId || '', reason: String(input.notes || '') })
      if (action.status !== 'Complete') action.status = 'In Progress'
      action.vendors = [...new Set([...action.vendors, vendor])]; break
    }
    case 'ready': {
      requirePermission(actor, 'invoice'); if (!action || !['Approved', 'In Progress', 'Complete'].includes(action.status)) fail('Approve the Action before billing.'); action.readyToBill = Boolean(input.ready); break
    }
    case 'draft_invoice': {
      requirePermission(actor, 'invoice')
      if (!Array.isArray(input.allocations) || !input.allocations.length) fail('Select at least one Action to invoice.')
      const seen = new Set()
      const allocations = input.allocations.map(item => {
        const a = state.actions.find(a => a.id === item.actionId)
        if (!a || !a.readyToBill || !['Approved', 'In Progress', 'Complete'].includes(a.status)) fail('Every invoice Action must be approved and Ready to Bill.')
        if (seen.has(a.id)) fail('An Action may appear only once on an invoice.')
        seen.add(a.id); const t = actionFinancials(state, a.id); const n = amount(item.amount)
        if (!n || n > t.billable || n + t.draftReserved + t.invoiced > t.committed) fail(`Duplicate or excess billing prevented for ${a.number}.`, 409)
        return { id: ctx.id(), actionId: a.id, actionNumber: a.number, description: String(item.description || a.description), amount: n }
      })
      const invoice = { id: ctx.id(), projectId: state.projectId, number: `INV-${input.projectNumber || state.projectId}-${String(state.nextInvoice++).padStart(4, '0')}`, status: 'Draft', invoiceDate: date(input.invoiceDate || ctx.now.slice(0, 10)), dueDate: date(input.dueDate || input.invoiceDate || ctx.now.slice(0, 10)), allocations, total: allocations.reduce((n, a) => n + a.amount, 0), createdAt: ctx.now, customerSnapshot: options.project ? Object.fromEntries(['projectNumber','projectName','customer','customerContactName','customerAddress1','customerAddress2','customerCity','customerState','customerZip','customerCountry','customerEmail','customerPhone','customerNumber'].map(k => [k, options.project[k] || ''])) : null }
      if (invoice.dueDate < invoice.invoiceDate) fail('Due date cannot precede invoice date.')
      state.invoices.push(invoice); audit(state, ctx, 'Draft customer invoice', invoice.id, null, invoice); break
    }
    case 'issue_invoice':
    case 'void_draft':
    case 'payment': {
      requirePermission(actor, 'invoice'); const invoice = state.invoices.find(i => i.id === input.invoiceId)
      if (!invoice) fail('Invoice not found.', 404)
      const old = clone(invoice)
      if (command.type === 'void_draft') { if (invoice.status !== 'Draft') fail('Issued invoices require a customer credit.'); required(input.reason, 'Void reason'); invoice.status = 'Void' }
      if (command.type === 'issue_invoice') {
        if (invoice.status !== 'Draft') fail('This invoice has already been issued or voided.', 409)
        for (const a of invoice.allocations) {
          const action = state.actions.find(i => i.id === a.actionId); const t = actionFinancials(state, a.actionId)
          if (!action || action.status === 'Cancelled' || t.invoiced + t.draftReserved > t.committed || t.billable < 0) fail('Invoice allocation exceeds approved billing capacity.', 409)
          post(state, ctx, { kind: 'Customer Invoice', actionId: a.actionId, invoiceId: invoice.id, invoiced: a.amount, reference: invoice.number })
        }
        invoice.status = 'Issued'; invoice.issuedAt = ctx.now
      }
      if (command.type === 'payment') {
        if (invoice.status !== 'Issued') fail('Only an issued invoice can receive payment.')
        let remaining = amount(input.amount); if (!remaining) fail('Payment must be positive.')
        const ref = required(input.reference, 'Payment reference')
        if (state.transactions.some(t => t.kind === 'Payment' && t.reference === ref)) fail('Payment reference already recorded.', 409)
        const outstanding = state.transactions.filter(t => t.invoiceId === invoice.id).reduce((n, t) => n + t.invoiced - t.paid, 0)
        if (remaining > outstanding) fail('Payment exceeds the unpaid invoice balance.')
        for (const a of invoice.allocations) {
          const balance = state.transactions.filter(t => t.invoiceId === invoice.id && t.actionId === a.actionId).reduce((n, t) => n + t.invoiced - t.paid, 0)
          const paid = Math.min(remaining, Math.max(0, balance)); if (paid) post(state, ctx, { kind: 'Payment', actionId: a.actionId, invoiceId: invoice.id, paid, reference: ref }); remaining -= paid
        }
      }
      audit(state, ctx, command.type, invoice.id, old, invoice, input.reason || ''); break
    }
    case 'funding': {
      requirePermission(actor, 'funding'); active(); if (action.type !== 'Funding Modification') fail('Select a Funding Modification Action.')
      const delta = amount(input.amount, true); if (!delta) fail('Funding change cannot be zero.')
      if (financialSummary(state).authorized + delta < 0) fail('Authorized funding cannot be negative.')
      if (state.transactions.some(t => t.kind === 'Funding Modification' && t.reference === input.reference)) fail('Funding modification reference already posted.',409)
      fundingCheck(state, ctx, 0, delta, input.overrideReason)
      post(state, ctx, { kind: 'Funding Modification', actionId: action.id, authorized: delta, reference: required(input.reference, 'Modification reference'), reason: required(input.reason, 'Funding modification reason') }); action.status = 'Complete'; break
    }
    case 'adjust': {
      requirePermission(actor, 'adjust'); active(); if (action.type !== 'Credit / Adjustment') fail('Select a Credit / Adjustment Action.')
      const target = state.actions.find(a => a.id === input.targetActionId)
      if (!target || !['Purchase Material', 'Direct Expense / Pass-Through', 'Create Customer Invoice'].includes(target.type)) fail('Select the affected procurement, expense, or billing Action.')
      const delta = amount(input.amount, true); if (!delta) fail('Adjustment cannot be zero.')
      if (state.transactions.some(t => t.kind === input.kind && t.reference === input.reference && t.actionId === input.targetActionId)) fail('Adjustment reference already posted for this Action.',409)
      const reason = required(input.reason, 'Adjustment explanation'); const t = actionFinancials(state, target.id)
      const tx = { kind: input.kind, actionId: target.id, adjustmentActionId: action.id, reason, reference: required(input.reference, 'Credit / adjustment reference') }
      if (input.kind === 'Vendor Credit') { if (delta >= 0 || t.actualCost + delta < 0) fail('Vendor credit must reduce recorded cost without making it negative.'); tx.actualCost = delta }
      else if (input.kind === 'Customer Credit') {
        const invoice = state.invoices.find(i => i.id === input.invoiceId && i.status === 'Issued' && i.allocations.some(a => a.actionId === target.id))
        if (!invoice) fail('Select an issued invoice containing the affected Action.')
        const outstanding = state.transactions.filter(t => t.invoiceId === invoice.id && t.actionId === target.id).reduce((n, t) => n + t.invoiced - t.paid, 0)
        if (delta >= 0 || -delta > outstanding) fail('Customer credit cannot exceed unpaid billing; record a payment reversal before crediting paid amounts.')
        tx.invoiced = delta; tx.invoiceId = invoice.id
        // A credit reduces the agreed sale as well; it does not silently make it billable again.
        tx.billAmount = delta
      }
      else if (input.kind === 'Cost Adjustment') { if (t.actualCost + delta < 0) fail('Actual cost cannot become negative.'); if (t.actualCost + delta > t.committed) fail('Cost adjustment exceeds the Action commitment. Approve additional funding first.',409); tx.actualCost = delta }
      else if (input.kind === 'Commitment Adjustment') {
        if (t.committed + delta < t.invoiced + t.draftReserved || t.committed + delta < 0 || t.committed + delta > target.authorizedAmount) fail('Commitment adjustment violates Action authorization or billing limits.')
        fundingCheck(state, ctx, delta, 0, input.overrideReason); tx.committed = delta
      }
      else if (input.kind === 'Payment Reversal') {
        const paid = state.transactions.filter(t => t.invoiceId === input.invoiceId && t.actionId === target.id).reduce((n, t) => n + t.paid, 0)
        if (delta >= 0 || -delta > paid) fail('Reversal must not exceed recorded payments.'); tx.paid = delta; tx.invoiceId = input.invoiceId
      }
      else fail('Choose a supported adjustment type.')
      post(state, ctx, tx); action.status = 'Complete'; break
    }
    case 'note': {
      requirePermission(actor,'edit'); if (!action) fail('Select an Action.');
      action.notes = [action.notes, `${ctx.now} — ${actor.name || actor.id}: ${required(input.note,'Note')}`].filter(Boolean).join('\n\n'); break
    }
    case 'document': {
      requirePermission(actor, 'edit'); if (!action) fail('Select an Action.')
      if (!input.storagePath?.startsWith(`${state.projectId}/${action.id}/`)) fail('Invalid document storage path.')
      state.documents.push({ id: ctx.id(), projectId: state.projectId, actionId: action.id, name: required(input.name, 'Document name'), kind: String(input.kind || 'Supporting document'), storagePath: input.storagePath, size: input.size, uploadedAt: ctx.now, uploadedBy: actor.id }); break
    }
    case 'review': {
      requirePermission(actor, 'adjust'); const item = state.review.find(i => i.id === input.reviewId); if (!item) fail('Review item not found.'); item.resolved = true; item.resolution = required(input.reason, 'Reconciliation explanation'); item.resolvedAt = ctx.now; item.resolvedBy = actor.id; break
    }
    default: fail('Unknown Managed Funds command.')
  }
  audit(state, ctx, command.type, action?.id || state.projectId, before, action || financialSummary(state), input.reason || input.notes || '')
  state.commands.push({ id: commandId, userId: actor.id, payload: JSON.stringify(command) })
  return state
}

// Existing quote/PO/tracking modules remain the document source of truth.
// This boundary validates financial edits before the project and ledger are atomically saved.
export function reconcileManagedProject(stateSource, previous, proposed, actor, options = {}) {
  requirePermission(actor, 'edit')
  const state = clone(stateSource), project = clone(proposed)
  const ctx = { actor, now: options.now || new Date().toISOString(), id: options.id || (() => crypto.randomUUID()) }
  if (!isManagedFunds(project) || project.id !== state.projectId) fail('A Managed Funds project cannot change its type or identity.')
  if (cents(project.checkbookStartingBalance || 0) !== state.originalFunding) fail('Original funding is immutable. Create a Funding Modification Action.')
  project.projectType = 'Managed Funds'
  const tracking = p => ({shipments:p.materialShipments || [],activity:p.materialTrackingActivity || [],inventory:p.inventory || [],pos:p.purchaseOrders || []})
  if (!same(tracking(previous),tracking(project))) requirePermission(actor,'issue_po')
  for (const collection of ['quotes', 'purchaseOrders']) {
    for (const old of previous[collection] || []) if (!(project[collection] || []).some(item => item.id === old.id)) fail('Managed Funds quotes and POs cannot be deleted. Preserve the document and record a cancellation or adjustment.')
  }
  for (const quote of project.quotes || []) {
    const old = (previous.quotes || []).find(q => q.id === quote.id)
    const action = state.actions.find(a => a.id === quote.actionId || a.quoteIds.includes(quote.id))
    if (!action || !['Purchase Material', 'Direct Expense / Pass-Through'].includes(action.type)) fail('Create or select a Managed Funds Action before saving a quote.')
    if (old?.actionId && old.actionId !== action.id) fail('A quote cannot be moved to another Action.')
    if (!same(old, quote) && ['Complete', 'Cancelled'].includes(action.status)) fail('This Action is closed; create a new Action for additional procurement.')
    quote.actionId = action.id; quote.actionNumber = action.number
    if (!action.quoteIds.includes(quote.id)) action.quoteIds.push(quote.id)
    if (old && old.status !== quote.status) requirePermission(actor,'approve')
    if (quote.status === 'Customer Approved') {
      if (!old || old.status !== quote.status || quoteCustomerTotal(old) !== quoteCustomerTotal(quote)) requirePermission(actor, 'approve')
      if (!['Approved', 'In Progress', 'Complete'].includes(action.status)) fail('Approve and commit funding on the Action before customer quote approval.')
    }
    if (!same(old, quote)) audit(state, ctx, 'Quote update', quote.id, old || null, quote, 'Existing Atlas quoting workflow')
  }
  for (const action of state.actions) {
    const approvedTotal = (project.quotes || []).filter(q => q.actionId === action.id && q.status === 'Customer Approved').reduce((n, q) => n + quoteCustomerTotal(q), 0)
    const t = actionFinancials(state, action.id)
    if (approvedTotal > t.committed || approvedTotal > t.billAmount) fail(`${action.number}: approved quotes exceed the committed or bill amount. Update the Action authorization and approval first.`, 409)
  }
  const financiallyChangedActions = new Set()
  for (const po of project.purchaseOrders || []) {
    const old = (previous.purchaseOrders || []).find(p => p.id === po.id)
    const quote = (project.quotes || []).find(q => q.id === po.quoteId)
    const action = state.actions.find(a => a.id === (po.actionId || quote?.actionId) || a.poIds.includes(po.id))
    if (!action) fail('Every Managed Funds PO must belong to an Action.')
    if (old?.actionId && old.actionId !== action.id) fail('A PO cannot be moved to another Action.')
    const costs = p => ({ quoteId: p.quoteId, status: p.status === 'Cancelled' ? 'Cancelled' : 'Active', totalCost: p.totalCost, freightCost: p.freightCost || 0, customerTotalCost: p.customerTotalCost, lines: (p.lines || []).map(l => ({ id: l.id, quantity: l.quantityOrdered, cost: l.unitCost })) })
    const changed = !old || !same(costs(old), costs(po))
    if (changed) {
      financiallyChangedActions.add(action.id)
      requirePermission(actor, 'issue_po')
      if (!['Approved', 'In Progress'].includes(action.status)) fail('Approve the Action before issuing or changing a PO.')
      if (po.status === 'Cancelled') fail('PO cancellation requires reconciliation through a financial adjustment; retain the source PO.')
      for (const line of po.lines || []) { if (!Number.isFinite(line.quantityOrdered) || line.quantityOrdered < 0 || !Number.isFinite(line.unitCost) || line.unitCost < 0) fail('Invalid PO quantity or cost.') }
      const total = (po.lines || []).reduce((n, l) => n + cents(l.unitCost * l.quantityOrdered), 0) + cents(po.freightCost || 0)
      if (Math.abs(total - cents(po.totalCost)) > 1) fail('PO total does not match its lines and freight.')
      audit(state, ctx, 'PO financial update', po.id, old || null, po, 'Existing Atlas purchase order workflow')
    }
    po.actionId = action.id; po.actionNumber = action.number
    if (!action.poIds.includes(po.id)) action.poIds.push(po.id)
    action.vendors = [...new Set([...action.vendors, po.vendor].filter(Boolean))]
  }
  for (const actionId of financiallyChangedActions) {
    const cost = (project.purchaseOrders || []).filter(po=>po.actionId===actionId && po.status!=='Cancelled').reduce((n,po)=>n+cents(po.totalCost || 0),0)
    if (cost > actionFinancials(state,actionId).committed) fail('PO costs exceed the Action commitment. Approve additional funding before issuing or increasing POs.',409)
  }
  return { state, project }
}
