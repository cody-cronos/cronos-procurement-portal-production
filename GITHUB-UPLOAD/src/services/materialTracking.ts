import type { MaterialShipment, MaterialTrackingActivity, Project, PurchaseOrder, PurchaseOrderLine, UserSession } from '../types'
import type { TrackingImportInput } from './trackingImport'

export type MaterialLineStatus = 'Not Ordered' | 'Ordered' | 'Partial' | 'Shipped' | 'In Transit' | 'Delivered' | 'Cancelled'
export type CustomerMaterialStatus = 'PO Issued' | 'Processing' | 'In Transit' | 'Delivered'
export type CustomerTrackingSummaryCounts = Record<CustomerMaterialStatus, number>
export type ShipmentLineInput = { poId: string; melLineItemId: string; quantity: number }
export type CreateShipmentInput = { poId: string; carrier: string; otherCarrier?: string; trackingNumber: string; actualShipDate: string; expectedDeliveryDate?: string; packingSlipNumber?: string; notes?: string; lines: ShipmentLineInput[] }
export type EditShipmentInput = Omit<CreateShipmentInput, 'poId' | 'lines'>
type TrackingActor = Pick<UserSession, 'id' | 'name'> & Partial<Pick<UserSession, 'role'>>
export function canManageMaterialTracking(actor: TrackingActor | null | undefined) { return !actor?.role || ['Admin', 'Procurement Team'].includes(actor.role) }
function requireTrackingPermission(actor: TrackingActor) { if (!canManageMaterialTracking(actor)) throw new Error('You do not have permission to modify material tracking.') }

export function migrateLegacyMaterialTracking(project: Project): Project {
  if ((project.materialShipments?.length ?? 0) || project.materialTrackingActivity?.length) return { ...project, materialShipments: project.materialShipments ?? [], materialTrackingActivity: project.materialTrackingActivity ?? [] }
  const now = project.updatedAt || project.createdAt || new Date().toISOString()
  const shipments: MaterialShipment[] = []
  for (const po of project.purchaseOrders ?? []) for (const line of po.lines ?? []) {
    const trackingNumber = String(line.trackingNumber || '').trim()
    const shipped = legacyShippedQuantity(line)
    if (!trackingNumber && !shipped) continue
    const shipmentId = `legacy-${po.id}-${line.id}`
    const quote = project.quotes.find(item => item.id === po.quoteId)
    shipments.push({ id: shipmentId, projectId: project.id, poId: po.id, vendor: po.vendor, carrier: String(line.carrier || po.carrier || '').trim(), trackingNumber, actualShipDate: line.estimatedShipDate || po.estimatedShipDate || '', expectedDeliveryDate: line.estimatedDeliveryDate || po.expectedDeliveryDate || '', deliveredDate: line.receivedDate || '', notes: line.notes || 'Migrated from legacy line tracking.', createdBy: 'legacy-migration', createdByName: 'Atlas migration', createdAt: now, updatedAt: now, lines: [{ id: `${shipmentId}-${line.id}`, shipmentId, poId: po.id, quoteId: po.quoteId, quoteNumber: quote?.quoteNumber, quoteName: quote?.quoteName, melLineItemId: line.id, quantityShipped: shipped || line.quantityOrdered, quantityDelivered: line.receivedDate ? Math.min(line.quantityReceived || line.quantityOrdered, line.quantityOrdered) : 0, deliveredDate: line.receivedDate || '', deliveredByUserId: line.receivedDate ? 'legacy-migration' : undefined, deliveredByUserName: line.receivedDate ? 'Atlas migration' : undefined, deliveredAt: line.receivedDate ? now : undefined }] })
  }
  return { ...project, materialShipments: shipments, materialTrackingActivity: [] }
}

export function createMaterialShipment(project: Project, input: CreateShipmentInput, actor: TrackingActor): Project {
  requireTrackingPermission(actor)
  const po = project.purchaseOrders.find(item => item.id === input.poId)
  if (!po) throw new Error('Purchase order not found.')
  const carrier = (input.carrier === 'Other' ? input.otherCarrier : input.carrier)?.trim() || ''
  if (!carrier) throw new Error('Carrier is required.')
  if (!input.actualShipDate) throw new Error('Actual ship date is required.')
  if (!input.lines.length) throw new Error('Select at least one MEL line.')
  const trackingNumber = input.trackingNumber.trim()
  const duplicate = (project.materialShipments ?? []).find(shipment => shipment.poId === po.id && shipment.vendor === po.vendor && trackingNumber && shipment.trackingNumber.toLowerCase() === trackingNumber.toLowerCase())
  const now = new Date().toISOString(); const shipmentId = duplicate?.id ?? crypto.randomUUID()
  const shipmentLines = input.lines.map(entry => {
    const line = po.lines.find(item => item.id === entry.melLineItemId)
    if (!line) throw new Error('A selected MEL line no longer exists.')
    const quantity = Number(entry.quantity); const remaining = lineQuantityRemaining(project, po.id, line.id)
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Shipment quantity for ${line.partNumber || line.description} must be greater than zero.`)
    if (quantity > remaining) throw new Error(`Shipment quantity for ${line.partNumber || line.description} exceeds the ${remaining} remaining.`)
    const quote = project.quotes.find(item => item.id === po.quoteId)
    return { id: crypto.randomUUID(), shipmentId, poId: po.id, quoteId: po.quoteId, quoteNumber: quote?.quoteNumber, quoteName: quote?.quoteName, melLineItemId: line.id, quantityShipped: quantity, quantityDelivered: 0 }
  })
  let shipments = [...(project.materialShipments ?? [])]
  if (duplicate) shipments = shipments.map(item => item.id === duplicate.id ? { ...item, carrier, actualShipDate: input.actualShipDate, expectedDeliveryDate: input.expectedDeliveryDate || item.expectedDeliveryDate, packingSlipNumber: input.packingSlipNumber?.trim() || item.packingSlipNumber, notes: input.notes?.trim() || item.notes, updatedAt: now, lines: [...item.lines, ...shipmentLines] } : item)
  else shipments.push({ id: shipmentId, projectId: project.id, poId: po.id, vendor: po.vendor, carrier, trackingNumber, actualShipDate: input.actualShipDate, expectedDeliveryDate: input.expectedDeliveryDate || '', packingSlipNumber: input.packingSlipNumber?.trim() || '', notes: input.notes?.trim() || '', createdBy: actor.id, createdByName: actor.name, createdAt: now, updatedAt: now, lines: shipmentLines })
  const activity = shipmentLines.map(entry => activityRow(project, po.id, entry.melLineItemId, shipmentId, 'Shipment added', actor, '', `${entry.quantityShipped} units via ${carrier}${trackingNumber ? ` · ${trackingNumber}` : ''}`, now))
  return synchronizeLegacyTracking({ ...project, materialShipments: shipments, materialTrackingActivity: [...(project.materialTrackingActivity ?? []), ...activity], updatedAt: now })
}

export function editMaterialShipment(project: Project, shipmentId: string, input: EditShipmentInput, actor: TrackingActor): Project {
  requireTrackingPermission(actor)
  const shipment = (project.materialShipments ?? []).find(item => item.id === shipmentId)
  if (!shipment) throw new Error('Shipment not found. Reload before editing.')
  const carrier = (input.carrier === 'Other' ? input.otherCarrier : input.carrier)?.trim() || ''
  if (!carrier) throw new Error('Carrier is required.')
  const actualShipDate = input.actualShipDate.trim()
  if (!actualShipDate) throw new Error('Actual ship date is required.')
  const trackingNumber = input.trackingNumber.trim()
  const duplicate = (project.materialShipments ?? []).some(item => item.id !== shipmentId && item.poId === shipment.poId && item.vendor === shipment.vendor && trackingNumber && item.trackingNumber.toLowerCase() === trackingNumber.toLowerCase())
  if (duplicate) throw new Error('Another shipment on this purchase order already uses that tracking number. Edit that shipment or enter a different tracking number.')

  // Only shipment details are editable here; identities, quantities and delivery confirmations stay intact.
  const details = { carrier, trackingNumber, actualShipDate, expectedDeliveryDate: input.expectedDeliveryDate?.trim() || '', packingSlipNumber: input.packingSlipNumber?.trim() || '', notes: input.notes?.trim() || '' }
  const fields: [keyof typeof details, string][] = [['carrier', 'Carrier'], ['trackingNumber', 'Tracking number'], ['actualShipDate', 'Ship date'], ['expectedDeliveryDate', 'Expected delivery'], ['packingSlipNumber', 'Packing slip'], ['notes', 'Notes']]
  const changed = fields.filter(([key]) => (shipment[key] || '') !== details[key])
  if (!changed.length) return project
  const now = new Date().toISOString()
  const previousValue = changed.map(([key, label]) => `${label}: ${shipment[key] || '(empty)'}`).join(' · ')
  const newValue = changed.map(([key, label]) => `${label}: ${shipment[key] || '(empty)'} → ${details[key] || '(empty)'}`).join(' · ')
  const activity = [...new Set(shipment.lines.map(line => line.melLineItemId))].map(lineId => activityRow(project, shipment.poId, lineId, shipmentId, 'Shipment edited', actor, previousValue, newValue, now))
  return synchronizeLegacyTracking({
    ...project,
    materialShipments: (project.materialShipments ?? []).map(item => item.id === shipmentId ? { ...item, ...details, updatedAt: now } : item),
    materialTrackingActivity: [...(project.materialTrackingActivity ?? []), ...activity],
    updatedAt: now,
  })
}

export function updateMaterialExpectedShipDate(project: Project, poId: string, lineId: string, expectedShipDate: string, actor: TrackingActor): Project {
  requireTrackingPermission(actor)
  const po = project.purchaseOrders.find(item => item.id === poId); const line = po?.lines.find(item => item.id === lineId)
  if (!po || !line) throw new Error('MEL line not found.')
  const now = new Date().toISOString()
  return { ...project, updatedAt: now, purchaseOrders: project.purchaseOrders.map(item => item.id === poId ? { ...item, lines: item.lines.map(candidate => candidate.id === lineId ? { ...candidate, estimatedShipDate: expectedShipDate } : candidate) } : item), materialTrackingActivity: [...(project.materialTrackingActivity ?? []), activityRow(project, poId, lineId, undefined, 'Expected ship date changed', actor, line.estimatedShipDate || '', expectedShipDate, now)] }
}

export function markMaterialShipmentDelivered(project: Project, shipmentId: string, deliveredDate: string, actor: TrackingActor): Project {
  requireTrackingPermission(actor)
  if (!deliveredDate) throw new Error('Delivered date is required.')
  const shipment = (project.materialShipments ?? []).find(item => item.id === shipmentId); if (!shipment) throw new Error('Shipment not found.')
  const now = new Date().toISOString(); const updated = (project.materialShipments ?? []).map(item => item.id === shipmentId ? { ...item, deliveredDate, updatedAt: now, lines: item.lines.map(line => ({ ...line, quantityDelivered: line.quantityShipped, deliveredDate, deliveredByUserId: actor.id, deliveredByUserName: actor.name, deliveredAt: now })) } : item)
  const activity = shipment.lines.map(line => activityRow(project, shipment.poId, line.melLineItemId, shipmentId, 'Shipment delivered', actor, '', deliveredDate, now))
  return synchronizeLegacyTracking({ ...project, materialShipments: updated, materialTrackingActivity: [...(project.materialTrackingActivity ?? []), ...activity], updatedAt: now })
}

export function markMaterialLineDelivered(project: Project, poId: string, lineId: string, deliveredDate: string, actor: TrackingActor): Project {
  requireTrackingPermission(actor)
  if (!deliveredDate) throw new Error('Delivered date is required.')
  const po = project.purchaseOrders.find(item => item.id === poId); const line = po?.lines.find(item => item.id === lineId)
  if (!po || !line) throw new Error('MEL line not found.')
  const now = new Date().toISOString(); const previous = customerMaterialStatus(project, po, line); let shipments = [...(project.materialShipments ?? [])]
  const remaining = lineQuantityRemaining(project, poId, lineId)
  if (remaining > 0) {
    const quote = project.quotes.find(item => item.id === po.quoteId); const shipmentId = crypto.randomUUID()
    shipments.push({ id: shipmentId, projectId: project.id, poId, vendor: po.vendor, carrier: 'Delivery confirmed', trackingNumber: '', actualShipDate: deliveredDate, deliveredDate, notes: 'Delivery confirmed directly at the MEL line level.', createdBy: actor.id, createdByName: actor.name, createdAt: now, updatedAt: now, lines: [{ id: crypto.randomUUID(), shipmentId, poId, quoteId: po.quoteId, quoteNumber: quote?.quoteNumber, quoteName: quote?.quoteName, melLineItemId: lineId, quantityShipped: remaining, quantityDelivered: remaining, deliveredDate, deliveredByUserId: actor.id, deliveredByUserName: actor.name, deliveredAt: now }] })
  }
  shipments = shipments.map(shipment => {
    if (shipment.poId !== poId || !shipment.lines.some(item => item.melLineItemId === lineId)) return shipment
    const lines = shipment.lines.map(item => item.melLineItemId === lineId ? { ...item, quantityDelivered: item.quantityShipped, deliveredDate, deliveredByUserId: actor.id, deliveredByUserName: actor.name, deliveredAt: now } : item)
    return { ...shipment, deliveredDate: lines.every(item => item.quantityDelivered >= item.quantityShipped) ? deliveredDate : shipment.deliveredDate, updatedAt: now, lines }
  })
  const activity = activityRow(project, poId, lineId, undefined, 'Line marked delivered', actor, previous, `Delivered · ${line.quantityOrdered} units · ${deliveredDate}`, now)
  return synchronizeLegacyTracking({ ...project, materialShipments: shipments, materialTrackingActivity: [...(project.materialTrackingActivity ?? []), activity], updatedAt: now })
}

export function reverseMaterialLineDelivery(project: Project, poId: string, lineId: string, actor: TrackingActor): Project {
  requireTrackingPermission(actor)
  const po = project.purchaseOrders.find(item => item.id === poId); const line = po?.lines.find(item => item.id === lineId)
  if (!po || !line) throw new Error('MEL line not found.')
  const now = new Date().toISOString(); const previous = customerMaterialStatus(project, po, line)
  const shipments = (project.materialShipments ?? []).map(shipment => {
    if (shipment.poId !== poId || !shipment.lines.some(item => item.melLineItemId === lineId)) return shipment
    const lines = shipment.lines.map(item => item.melLineItemId === lineId ? { ...item, quantityDelivered: 0, deliveredDate: '', deliveredByUserId: undefined, deliveredByUserName: undefined, deliveredAt: undefined } : item)
    const deliveredDates = lines.filter(item => item.quantityDelivered >= item.quantityShipped).map(item => item.deliveredDate || '').filter(Boolean)
    return { ...shipment, deliveredDate: lines.every(item => item.quantityDelivered >= item.quantityShipped) ? deliveredDates.sort().at(-1) || shipment.deliveredDate : '', updatedAt: now, lines }
  })
  const activity = activityRow(project, poId, lineId, undefined, 'Delivery confirmation reversed', actor, previous, 'In Transit', now)
  return synchronizeLegacyTracking({ ...project, materialShipments: shipments, materialTrackingActivity: [...(project.materialTrackingActivity ?? []), activity], updatedAt: now })
}

export function editMaterialLineDeliveredDate(project: Project, poId: string, lineId: string, deliveredDate: string, actor: TrackingActor): Project {
  requireTrackingPermission(actor)
  if (!deliveredDate) throw new Error('Delivered date is required.')
  const now = new Date().toISOString(); let previousDate = ''
  const shipments = (project.materialShipments ?? []).map(shipment => {
    if (shipment.poId !== poId || !shipment.lines.some(item => item.melLineItemId === lineId && item.quantityDelivered > 0)) return shipment
    const lines = shipment.lines.map(item => { if (item.melLineItemId !== lineId || item.quantityDelivered <= 0) return item; previousDate ||= item.deliveredDate || ''; return { ...item, deliveredDate, deliveredByUserId: actor.id, deliveredByUserName: actor.name, deliveredAt: now } })
    const dates = lines.filter(item => item.quantityDelivered >= item.quantityShipped).map(item => item.deliveredDate || '').filter(Boolean)
    return { ...shipment, deliveredDate: lines.every(item => item.quantityDelivered >= item.quantityShipped) ? dates.sort().at(-1) || deliveredDate : '', updatedAt: now, lines }
  })
  const activity = activityRow(project, poId, lineId, undefined, 'Delivered date corrected', actor, previousDate, deliveredDate, now)
  return synchronizeLegacyTracking({ ...project, materialShipments: shipments, materialTrackingActivity: [...(project.materialTrackingActivity ?? []), activity], updatedAt: now })
}

export function importMaterialTracking(project: Project, rows: TrackingImportInput[], actor: TrackingActor) {
  requireTrackingPermission(actor)
  let next = project; let importedCount = 0; const review: TrackingImportInput[] = []
  for (const row of rows.filter(item => !item.projectNumber || normalize(item.projectNumber) === normalize(project.projectNumber))) {
    const po = project.purchaseOrders.find(item => normalize(item.poNumber) === normalize(row.poNumber)); if (!po) { review.push(row); continue }
    const byPart = po.lines.filter(line => row.partNumber && normalize(line.partNumber) === normalize(row.partNumber)); const byItem = !row.partNumber && row.itemNumber ? po.lines.filter(line => normalize(line.itemNumber || line.clin) === normalize(row.itemNumber)) : []; const matches = byPart.length ? byPart : byItem
    if (matches.length !== 1 || !row.trackingNumber) { review.push(row); continue }
    const line = matches[0]; const remaining = lineQuantityRemaining(next, po.id, line.id); const quantity = Math.min(row.quantity || remaining, remaining)
    if (quantity <= 0) { review.push(row); continue }
    next = createMaterialShipment(next, { poId: po.id, carrier: row.carrier || 'Other', otherCarrier: row.carrier || 'Imported', trackingNumber: row.trackingNumber, actualShipDate: row.estimatedShipDate || new Date().toISOString().slice(0, 10), expectedDeliveryDate: row.estimatedDeliveryDate, notes: row.notes, lines: [{ poId: po.id, melLineItemId: line.id, quantity }] }, actor)
    if (row.receivedDate) { const shipment = next.materialShipments?.find(item => item.poId === po.id && item.trackingNumber === row.trackingNumber); if (shipment) next = markMaterialShipmentDelivered(next, shipment.id, row.receivedDate, actor) }
    importedCount += 1
  }
  return { project: next, importedCount, review, skippedCount: review.length }
}

export function lineShipments(project: Project, poId: string, lineId: string) { return (project.materialShipments ?? []).filter(shipment => shipment.poId === poId && shipment.lines.some(line => line.melLineItemId === lineId)) }
export function lineQuantityShipped(project: Project, poId: string, lineId: string) { return lineShipments(project, poId, lineId).reduce((sum, shipment) => sum + shipment.lines.filter(line => line.melLineItemId === lineId).reduce((n, line) => n + line.quantityShipped, 0), 0) }
export function lineQuantityDelivered(project: Project, poId: string, lineId: string) { return lineShipments(project, poId, lineId).reduce((sum, shipment) => sum + shipment.lines.filter(line => line.melLineItemId === lineId).reduce((n, line) => n + line.quantityDelivered, 0), 0) }
export function lineQuantityRemaining(project: Project, poId: string, lineId: string) { const line = project.purchaseOrders.find(po => po.id === poId)?.lines.find(item => item.id === lineId); return Math.max(0, (line?.quantityOrdered ?? 0) - lineQuantityShipped(project, poId, lineId)) }
export function materialLineStatus(project: Project, po: PurchaseOrder, line: PurchaseOrderLine): MaterialLineStatus { if (line.status === 'Cancelled') return 'Cancelled'; const shipped = lineQuantityShipped(project, po.id, line.id), delivered = lineQuantityDelivered(project, po.id, line.id); if (delivered >= line.quantityOrdered && line.quantityOrdered > 0) return 'Delivered'; if (shipped > 0 && shipped < line.quantityOrdered) return 'Partial'; if (shipped >= line.quantityOrdered && line.quantityOrdered > 0) return lineShipments(project, po.id, line.id).some(item => !item.deliveredDate) ? 'In Transit' : 'Shipped'; return po.id ? 'Ordered' : 'Not Ordered' }
export function customerMaterialStatus(project: Project, po: PurchaseOrder, line: PurchaseOrderLine): CustomerMaterialStatus { const delivered = lineQuantityDelivered(project, po.id, line.id); if (delivered >= line.quantityOrdered && line.quantityOrdered > 0) return 'Delivered'; if (lineQuantityShipped(project, po.id, line.id) > 0) return 'In Transit'; if (line.estimatedShipDate || line.vendorOrderNumber || ['Ordered', 'Awaiting Vendor Shipment'].includes(line.status)) return 'Processing'; return 'PO Issued' }
export function customerTrackingSummaryCounts(lines: Array<{ poNumber?: string; status?: string; customerStatus?: CustomerMaterialStatus }>): CustomerTrackingSummaryCounts {
  const counts: CustomerTrackingSummaryCounts = { 'PO Issued': 0, Processing: 0, 'In Transit': 0, Delivered: 0 }
  for (const line of lines) {
    if (line.poNumber?.trim()) counts['PO Issued'] += 1
    const currentStatus: CustomerMaterialStatus = line.customerStatus
      || (line.status === 'Processing' || line.status === 'In Transit' || line.status === 'Delivered' ? line.status : 'PO Issued')
    if (currentStatus !== 'PO Issued') counts[currentStatus] += 1
  }
  return counts
}
export function materialQuoteIdentity(project: Project, po: PurchaseOrder) { const quote = project.quotes.find(item => item.id === po.quoteId); return { quoteId: quote?.id || po.quoteId || '', quoteNumber: quote?.quoteNumber || 'Unassigned Quote / MEL', quoteName: quote?.quoteName?.trim() || quote?.quoteNumber || 'Unassigned Quote / MEL', melId: quote?.id || po.quoteId || '' } }
export function isMaterialLineLate(project: Project, po: PurchaseOrder, line: PurchaseOrderLine, today = new Date()) { const date = line.estimatedShipDate; return Boolean(date && new Date(`${date}T23:59:59`).getTime() < today.getTime() && lineQuantityRemaining(project, po.id, line.id) > 0) }
export function materialLineNeedsTracking(project: Project, po: PurchaseOrder, line: PurchaseOrderLine) { const status = materialLineStatus(project, po, line); return (['Shipped', 'In Transit'].includes(status) || Boolean(line.receivedDate)) && lineShipments(project, po.id, line.id).some(shipment => !shipment.trackingNumber) }
export function carrierTrackingUrl(carrier: string, tracking: string) { const value = tracking.trim(); if (!value) return ''; const name = carrier.toLowerCase(); if (name.includes('ups')) return `https://www.ups.com/track?tracknum=${encodeURIComponent(value)}`; if (name.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(value)}`; if (name.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(value)}`; if (name.includes('dhl')) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${encodeURIComponent(value)}`; return '' }

export function shipmentLineExportRows(project: Project) {
  return project.purchaseOrders.flatMap(po => po.lines.flatMap((line, lineIndex) => { const shipments = lineShipments(project, po.id, line.id); const quote = materialQuoteIdentity(project, po); const base = { projectId: project.id, projectNumber: project.projectNumber, projectName: project.projectName, customer: project.customer, quoteId: quote.quoteId, quoteNumber: quote.quoteNumber, quoteName: quote.quoteName, melId: quote.melId, materialLineId: line.id, lineNumber: line.itemNumber || line.clin || String(lineIndex + 1), poNumber: po.poNumber, vendor: po.vendor, manufacturer: line.manufacturer || '', partNumber: line.partNumber, description: line.description, quantityOrdered: line.quantityOrdered, quantityShipped: lineQuantityShipped(project, po.id, line.id), quantityRemaining: lineQuantityRemaining(project, po.id, line.id), expectedShipDate: line.estimatedShipDate || '', status: customerMaterialStatus(project, po, line), customerNote: line.customerNote || '' }; return shipments.length ? shipments.flatMap(shipment => shipment.lines.filter(item => item.melLineItemId === line.id).map(item => ({ ...base, shipmentQuantity: item.quantityShipped, actualShipDate: shipment.actualShipDate, carrier: shipment.carrier, trackingNumber: shipment.trackingNumber, expectedDeliveryDate: shipment.expectedDeliveryDate || '', deliveredDate: item.deliveredDate || '', quantityDelivered: item.quantityDelivered }))) : [{ ...base, shipmentQuantity: 0, actualShipDate: '', carrier: '', trackingNumber: '', expectedDeliveryDate: '', deliveredDate: '', quantityDelivered: 0 }] }))
}

function synchronizeLegacyTracking(project: Project): Project { return { ...project, purchaseOrders: project.purchaseOrders.map(po => ({ ...po, lines: po.lines.map(line => { const shipments = lineShipments(project, po.id, line.id), shipped = lineQuantityShipped(project, po.id, line.id), delivered = lineQuantityDelivered(project, po.id, line.id), latest = shipments.slice().sort((a, b) => b.actualShipDate.localeCompare(a.actualShipDate))[0]; return { ...line, quantityReceived: Math.min(delivered, line.quantityOrdered), status: materialLineStatus(project, po, line) === 'Delivered' ? 'Delivered' : shipped >= line.quantityOrdered ? 'Shipped' : shipped > 0 ? 'Partially Shipped' : line.status, carrier: latest?.carrier ?? line.carrier, trackingNumber: latest?.trackingNumber ?? line.trackingNumber, trackingUrl: latest ? carrierTrackingUrl(latest.carrier, latest.trackingNumber) : line.trackingUrl, receivedDate: delivered ? latest?.deliveredDate || line.receivedDate : line.receivedDate } }) })) } }
function legacyShippedQuantity(line: PurchaseOrderLine) { return ['Shipped', 'Delivered', 'Received'].includes(line.status) || line.trackingNumber ? line.quantityOrdered : line.quantityReceived || 0 }
function activityRow(project: Project, poId: string, lineId: string | undefined, shipmentId: string | undefined, action: string, actor: TrackingActor, previousValue: string, newValue: string, occurredAt: string): MaterialTrackingActivity { return { id: crypto.randomUUID(), projectId: project.id, poId, melLineItemId: lineId, shipmentId, action, actorId: actor.id, actorName: actor.name, occurredAt, previousValue, newValue } }
function normalize(value: string) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '') }
