import test from 'node:test'
import assert from 'node:assert/strict'
import { createMaterialShipment, customerMaterialStatus, customerTrackingSummaryCounts, editMaterialLineDeliveredDate, editMaterialShipment, importMaterialTracking, isMaterialLineLate, lineQuantityDelivered, lineQuantityRemaining, lineQuantityShipped, markMaterialLineDelivered, markMaterialShipmentDelivered, materialLineStatus, reverseMaterialLineDelivery, shipmentLineExportRows, updateMaterialExpectedShipDate } from '../../src/services/materialTracking.ts'

const actor = { id: 'u1', name: 'Procurement User', role: 'Procurement Team' }
const line = (id, quantity = 20) => ({ id, clin: id, partNumber: id.toUpperCase(), manufacturer: 'Lencore', description: `Material ${id}`, quantityOrdered: quantity, quantityReceived: 0, unitCost: 10, status: 'Ordered', estimatedShipDate: '' })
const project = (lines = [line('g950')]) => ({ id: 'p1', projectNumber: '26-087', projectName: 'ONI Washington DC', customer: 'FGS', status: 'Active', projectType: 'Design & Install', assignedUserIds: [], governmentProjectLead: '', quotes: [], quoteLines: [], inventory: [], kitStatus: 'Ordered', shipmentStatus: 'Ordered', purchaseOrders: [{ id: 'po1', poNumber: '26-087-0001-Accu-Tech', vendor: 'Accu-Tech', dateIssued: '2026-08-20', status: 'Ordered', totalCost: 0, lines }], materialShipments: [], materialTrackingActivity: [] })
const ship = (p, tracking, quantities, date = '2026-08-26') => createMaterialShipment(p, { poId: 'po1', carrier: 'UPS', trackingNumber: tracking, actualShipDate: date, lines: quantities.map(([melLineItemId, quantity]) => ({ poId: 'po1', melLineItemId, quantity })) }, actor)

test('one MEL line ships completely under one tracking number', () => { const p = ship(project(), '1Z111', [['g950', 20]]); assert.equal(lineQuantityShipped(p, 'po1', 'g950'), 20); assert.equal(materialLineStatus(p, p.purchaseOrders[0], p.purchaseOrders[0].lines[0]), 'In Transit') })
test('one MEL line supports two partial shipments without overwrite', () => { let p = ship(project(), '1Z111', [['g950', 10]]); p = ship(p, '1Z222', [['g950', 5]]); assert.equal(p.materialShipments.length, 2); assert.equal(lineQuantityShipped(p, 'po1', 'g950'), 15); assert.equal(lineQuantityRemaining(p, 'po1', 'g950'), 5); assert.equal(materialLineStatus(p, p.purchaseOrders[0], p.purchaseOrders[0].lines[0]), 'Partial') })
test('one MEL line retains three tracking numbers', () => { let p = ship(project(), '1Z111', [['g950', 10]]); p = ship(p, '784512', [['g950', 5]]); p = ship(p, '1Z222', [['g950', 5]]); assert.deepEqual(p.materialShipments.map(item => item.trackingNumber), ['1Z111', '784512', '1Z222']) })
test('five MEL lines can share one shipment record', () => { const lines = Array.from({ length: 5 }, (_, index) => line(`line-${index}`, 5)); const p = ship(project(lines), '1ZBULK', lines.map(item => [item.id, 5])); assert.equal(p.materialShipments.length, 1); assert.equal(p.materialShipments[0].lines.length, 5) })
test('bulk shipment preserves different quantities per MEL line', () => { const p = ship(project([line('a', 5), line('b', 20), line('c', 1)]), '1ZMIXED', [['a', 5], ['b', 10], ['c', 1]]); assert.deepEqual(p.materialShipments[0].lines.map(item => item.quantityShipped), [5, 10, 1]) })
test('expected ship date changes are audited and late remains a warning', () => { const p = updateMaterialExpectedShipDate(project(), 'po1', 'g950', '2026-08-01', actor); assert.equal(p.purchaseOrders[0].lines[0].estimatedShipDate, '2026-08-01'); assert.equal(p.materialTrackingActivity.length, 1); assert.equal(isMaterialLineLate(p, p.purchaseOrders[0], p.purchaseOrders[0].lines[0], new Date('2026-08-26')), true); assert.equal(materialLineStatus(p, p.purchaseOrders[0], p.purchaseOrders[0].lines[0]), 'Ordered') })
test('shipment changes Ordered to Partial and final quantity to In Transit', () => { let p = ship(project(), '1Z111', [['g950', 10]]); assert.equal(materialLineStatus(p, p.purchaseOrders[0], p.purchaseOrders[0].lines[0]), 'Partial'); p = ship(p, '1Z222', [['g950', 10]]); assert.equal(materialLineStatus(p, p.purchaseOrders[0], p.purchaseOrders[0].lines[0]), 'In Transit') })
test('line becomes Delivered only when full ordered quantity is delivered', () => { let p = ship(project(), '1Z111', [['g950', 10]]); p = markMaterialShipmentDelivered(p, p.materialShipments[0].id, '2026-08-28', actor); assert.equal(lineQuantityDelivered(p, 'po1', 'g950'), 10); assert.equal(materialLineStatus(p, p.purchaseOrders[0], p.purchaseOrders[0].lines[0]), 'Partial'); p = ship(p, '1Z222', [['g950', 10]]); p = markMaterialShipmentDelivered(p, p.materialShipments[1].id, '2026-08-30', actor); assert.equal(materialLineStatus(p, p.purchaseOrders[0], p.purchaseOrders[0].lines[0]), 'Delivered') })
test('same tracking number on the same PO reuses one shipment without duplicate shipment records', () => { let p = ship(project([line('a', 2), line('b', 3)]), '1ZBOX', [['a', 2]]); p = ship(p, '1ZBOX', [['b', 3]]); assert.equal(p.materialShipments.length, 1); assert.equal(p.materialShipments[0].lines.length, 2) })
test('tracking import maps unique part numbers and flags ambiguous rows', () => { const base = project([line('a', 2), line('dup1', 2), line('dup2', 2)]); base.purchaseOrders[0].lines[1].partNumber = 'DUP'; base.purchaseOrders[0].lines[2].partNumber = 'DUP'; const rows = [{ itemNumber: '', projectNumber: '26-087', poNumber: '26-087-0001-Accu-Tech', vendor: 'Accu-Tech', partNumber: 'A', manufacturer: '', description: '', quantity: 2, trackingNumber: '1ZGOOD', estimatedShipDate: '2026-08-26', carrier: 'UPS' }, { itemNumber: '', projectNumber: '26-087', poNumber: '26-087-0001-Accu-Tech', vendor: 'Accu-Tech', partNumber: 'DUP', manufacturer: '', description: '', quantity: 1, trackingNumber: '1ZAMB', estimatedShipDate: '2026-08-26', carrier: 'UPS' }]; const result = importMaterialTracking(base, rows, actor); assert.equal(result.importedCount, 1); assert.equal(result.review.length, 1) })
test('shipment-line export emits one row per shipment relationship', () => { let p = ship(project(), '1Z111', [['g950', 10]]); p = ship(p, '1Z222', [['g950', 10]]); const rows = shipmentLineExportRows(p); assert.equal(rows.length, 2); assert.deepEqual(rows.map(row => row.trackingNumber), ['1Z111', '1Z222']) })
test('unauthorized roles cannot modify shipment records', () => assert.throws(() => createMaterialShipment(project(), { poId: 'po1', carrier: 'UPS', trackingNumber: '1Z', actualShipDate: '2026-08-26', lines: [{ poId: 'po1', melLineItemId: 'g950', quantity: 1 }] }, { id: 'e1', name: 'Engineer', role: 'Engineering' }), /permission/))
test('hundreds of MEL lines remain deterministic', () => { const lines = Array.from({ length: 500 }, (_, index) => line(`part-${index}`, 1)); const p = project(lines); const rows = shipmentLineExportRows(p); assert.equal(rows.length, 500); assert.ok(rows.every(row => row.quantityRemaining === 1)) })
test('customer status is limited to the four approved values', () => { const base = project([line('issued'), { ...line('processing'), estimatedShipDate: '2026-09-01' }]); base.purchaseOrders[0].lines[0].status = 'PO Issued'; assert.equal(customerMaterialStatus(base, base.purchaseOrders[0], base.purchaseOrders[0].lines[0]), 'PO Issued'); assert.equal(customerMaterialStatus(base, base.purchaseOrders[0], base.purchaseOrders[0].lines[1]), 'Processing'); const partial = ship(project(), '1ZPART', [['g950', 1]]); assert.equal(customerMaterialStatus(partial, partial.purchaseOrders[0], partial.purchaseOrders[0].lines[0]), 'In Transit') })
test('tracking summary keeps PO Issued cumulative as fulfillment advances', () => {
  const counts = customerTrackingSummaryCounts([
    { poNumber: 'PO-1', status: 'PO Issued' },
    { poNumber: 'PO-2', status: 'Processing' },
    { poNumber: 'PO-3', status: 'In Transit' },
    { poNumber: 'PO-4', status: 'Delivered' },
    { poNumber: '', status: 'Processing' },
  ])
  assert.deepEqual(counts, { 'PO Issued': 4, Processing: 2, 'In Transit': 1, Delivered: 1 })
})
test('tracking summary accepts workbook customerStatus rows', () => {
  assert.deepEqual(customerTrackingSummaryCounts([
    { poNumber: 'PO-1', customerStatus: 'Processing' },
    { poNumber: 'PO-2', customerStatus: 'Delivered' },
  ]), { 'PO Issued': 2, Processing: 1, 'In Transit': 0, Delivered: 1 })
})
test('expected dates never auto-confirm delivery', () => { const base = project(); base.purchaseOrders[0].lines[0].estimatedDeliveryDate = '2020-01-01'; assert.notEqual(customerMaterialStatus(base, base.purchaseOrders[0], base.purchaseOrders[0].lines[0]), 'Delivered') })
test('direct line delivery can be edited and reversed with audit history', () => { let p = markMaterialLineDelivered(project(), 'po1', 'g950', '2026-08-28', actor); assert.equal(customerMaterialStatus(p, p.purchaseOrders[0], p.purchaseOrders[0].lines[0]), 'Delivered'); assert.equal(p.materialTrackingActivity.at(-1).action, 'Line marked delivered'); p = editMaterialLineDeliveredDate(p, 'po1', 'g950', '2026-08-29', actor); assert.ok(p.materialShipments[0].lines.every(item => item.deliveredDate === '2026-08-29')); p = reverseMaterialLineDelivery(p, 'po1', 'g950', actor); assert.equal(customerMaterialStatus(p, p.purchaseOrders[0], p.purchaseOrders[0].lines[0]), 'In Transit'); assert.equal(p.materialTrackingActivity.at(-1).action, 'Delivery confirmation reversed') })
test('quote identity keeps duplicate part numbers in separate MEL groups', () => { const p = project([line('a', 1)]); p.quotes = [{ id: 'q1', quoteNumber: 'MEL-001', quoteName: 'First' }]; p.purchaseOrders[0].quoteId = 'q1'; p.purchaseOrders.push({ ...p.purchaseOrders[0], id: 'po2', poNumber: 'PO-2', quoteId: 'q2', lines: [{ ...line('b', 1), partNumber: 'A' }] }); p.quotes.push({ id: 'q2', quoteNumber: 'MEL-002', quoteName: 'Second' }); const rows = shipmentLineExportRows(p); assert.deepEqual(rows.map(row => row.quoteNumber), ['MEL-001', 'MEL-002']); assert.notEqual(rows[0].materialLineId, rows[1].materialLineId) })

const shipmentDetails = shipment => ({ carrier: shipment.carrier, trackingNumber: shipment.trackingNumber, actualShipDate: shipment.actualShipDate, expectedDeliveryDate: shipment.expectedDeliveryDate, packingSlipNumber: shipment.packingSlipNumber, notes: shipment.notes })

test('carrier correction works with zero remaining and preserves shipment identity and history', () => {
  const before = createMaterialShipment(project([line('pfd-45a', 1)]), { poId: 'po1', carrier: 'Other', otherCarrier: 'R&L CARRIERS INC', trackingNumber: 'AJ0761193', actualShipDate: '2026-09-10', expectedDeliveryDate: '2026-09-14', lines: [{ poId: 'po1', melLineItemId: 'pfd-45a', quantity: 1 }] }, actor)
  const shipment = before.materialShipments[0]
  const after = editMaterialShipment(before, shipment.id, { ...shipmentDetails(shipment), carrier: 'FedEx', trackingNumber: ' 123456789012 ' }, actor)
  assert.equal(after.materialShipments.length, 1)
  assert.deepEqual(after.materialShipments[0], { ...shipment, carrier: 'FedEx', trackingNumber: '123456789012', updatedAt: after.updatedAt })
  assert.equal(lineQuantityShipped(after, 'po1', 'pfd-45a'), 1)
  assert.equal(lineQuantityRemaining(after, 'po1', 'pfd-45a'), 0)
  assert.equal(customerMaterialStatus(after, after.purchaseOrders[0], after.purchaseOrders[0].lines[0]), 'In Transit')
  assert.equal(after.purchaseOrders[0].lines[0].carrier, 'FedEx')
  assert.equal(after.purchaseOrders[0].lines[0].trackingNumber, '123456789012')
  assert.equal(after.purchaseOrders[0].lines[0].trackingUrl, 'https://www.fedex.com/fedextrack/?trknbr=123456789012')
  assert.equal(shipmentLineExportRows(after)[0].carrier, 'FedEx')
  assert.equal(after.materialTrackingActivity.at(-1).action, 'Shipment edited')
  assert.equal(after.materialTrackingActivity.at(-1).actorId, actor.id)
  assert.match(after.materialTrackingActivity.at(-1).previousValue, /R&L CARRIERS INC/)
  assert.match(after.materialTrackingActivity.at(-1).newValue, /R&L CARRIERS INC → FedEx/)
  assert.deepEqual(after.materialTrackingActivity.slice(0, -1), before.materialTrackingActivity)
  assert.equal(before.materialShipments[0].carrier, 'R&L CARRIERS INC')
})

test('editing a shared shipment preserves partial delivery and logs each affected line once', () => {
  let before = ship(project([line('a', 2), line('b', 3), line('c', 1)]), '1ZBOX', [['a', 1], ['b', 3]])
  before = ship(before, '1ZBOX', [['a', 1]])
  before = ship(before, 'UNRELATED', [['c', 1]])
  before = markMaterialLineDelivered(before, 'po1', 'a', '2026-09-14', actor)
  const shipment = before.materialShipments[0]
  const after = editMaterialShipment(before, shipment.id, { ...shipmentDetails(shipment), carrier: 'FedEx', actualShipDate: '2026-09-10', expectedDeliveryDate: '2026-09-16', packingSlipNumber: ' PACK-01 ', notes: ' Corrected carrier ' }, actor)
  assert.deepEqual(after.materialShipments[0].lines, shipment.lines)
  assert.equal(after.materialShipments[0].deliveredDate, shipment.deliveredDate)
  assert.equal(after.materialShipments[0].createdBy, shipment.createdBy)
  assert.equal(after.materialShipments[0].createdAt, shipment.createdAt)
  assert.equal(after.materialShipments[0].packingSlipNumber, 'PACK-01')
  assert.equal(after.materialShipments[0].notes, 'Corrected carrier')
  assert.deepEqual(after.materialShipments[1], before.materialShipments[1])
  assert.equal(lineQuantityDelivered(after, 'po1', 'a'), 2)
  assert.equal(lineQuantityDelivered(after, 'po1', 'b'), 0)
  assert.deepEqual(after.materialTrackingActivity.slice(before.materialTrackingActivity.length).map(item => item.melLineItemId), ['a', 'b'])
  assert.ok(shipmentLineExportRows(after).filter(row => row.materialLineId !== 'c').every(row => row.carrier === 'FedEx' && row.expectedDeliveryDate === '2026-09-16'))
})

test('delivered shipments retain every delivery confirmation when edited', () => {
  let before = ship(project(), '1Z111', [['g950', 20]])
  before = markMaterialShipmentDelivered(before, before.materialShipments[0].id, '2026-08-28', actor)
  const shipment = before.materialShipments[0]
  const after = editMaterialShipment(before, shipment.id, { ...shipmentDetails(shipment), carrier: 'FedEx' }, actor)
  assert.deepEqual(after.materialShipments[0].lines, shipment.lines)
  assert.equal(after.materialShipments[0].deliveredDate, '2026-08-28')
  assert.equal(lineQuantityDelivered(after, 'po1', 'g950'), 20)
  assert.equal(customerMaterialStatus(after, after.purchaseOrders[0], after.purchaseOrders[0].lines[0]), 'Delivered')
})

test('editing can clear optional details including legacy tracking number and URL', () => {
  const before = ship(project(), '1Z111', [['g950', 20]])
  const shipment = before.materialShipments[0]
  const filled = editMaterialShipment(before, shipment.id, { ...shipmentDetails(shipment), expectedDeliveryDate: '2026-09-14', packingSlipNumber: 'ABC', notes: 'Original' }, actor)
  const after = editMaterialShipment(filled, shipment.id, { ...shipmentDetails(filled.materialShipments[0]), trackingNumber: '', expectedDeliveryDate: '', packingSlipNumber: '', notes: '' }, actor)
  for (const key of ['trackingNumber', 'expectedDeliveryDate', 'packingSlipNumber', 'notes']) assert.equal(after.materialShipments[0][key], '')
  assert.equal(after.purchaseOrders[0].lines[0].trackingNumber, '')
  assert.equal(after.purchaseOrders[0].lines[0].trackingUrl, '')
  assert.equal(shipmentLineExportRows(after)[0].trackingNumber, '')
})

test('editing supports custom carriers and ignores quantity or delivery changes in the payload', () => {
  const before = ship(project(), '1Z111', [['g950', 20]])
  const shipment = before.materialShipments[0]
  const after = editMaterialShipment(before, shipment.id, { ...shipmentDetails(shipment), carrier: 'Other', otherCarrier: ' Local Freight ', lines: [], deliveredDate: '2026-09-14', id: 'replacement', poId: 'other-po' }, actor)
  assert.equal(after.materialShipments[0].carrier, 'Local Freight')
  assert.deepEqual(after.materialShipments[0].lines, shipment.lines)
  assert.equal(after.materialShipments[0].id, shipment.id)
  assert.equal(after.materialShipments[0].poId, shipment.poId)
  assert.equal(after.materialShipments[0].deliveredDate, shipment.deliveredDate)
})

test('editing rejects another shipment tracking number and leaves the project untouched', () => {
  let before = ship(project(), '1Z111', [['g950', 10]])
  before = ship(before, '1Z222', [['g950', 10]])
  const original = structuredClone(before), shipment = before.materialShipments[0]
  assert.throws(() => editMaterialShipment(before, shipment.id, { ...shipmentDetails(shipment), trackingNumber: ' 1z222 ' }, actor), /already uses that tracking number/)
  assert.deepEqual(before, original)
  assert.equal(editMaterialShipment(before, shipment.id, shipmentDetails(shipment), actor), before)
})

test('shipment editing requires permission, an existing shipment, carrier and ship date', () => {
  const before = ship(project(), '1Z111', [['g950', 20]])
  const shipment = before.materialShipments[0], details = shipmentDetails(shipment)
  assert.throws(() => editMaterialShipment(before, shipment.id, details, { id: 'e1', name: 'Engineer', role: 'Engineering' }), /permission/)
  assert.throws(() => editMaterialShipment(before, 'missing', details, actor), /Shipment not found/)
  assert.throws(() => editMaterialShipment(before, shipment.id, { ...details, carrier: ' ' }, actor), /Carrier is required/)
  assert.throws(() => editMaterialShipment(before, shipment.id, { ...details, carrier: 'Other', otherCarrier: ' ' }, actor), /Carrier is required/)
  assert.throws(() => editMaterialShipment(before, shipment.id, { ...details, actualShipDate: ' ' }, actor), /Actual ship date is required/)
})

test('editing an earlier shipment leaves the latest shipment summary intact', () => {
  let before = ship(project(), '1Z111', [['g950', 10]], '2026-08-25')
  before = ship(before, '1Z222', [['g950', 10]], '2026-08-26')
  const shipment = before.materialShipments[0]
  const after = editMaterialShipment(before, shipment.id, { ...shipmentDetails(shipment), carrier: 'FedEx' }, actor)
  assert.equal(after.materialShipments[0].carrier, 'FedEx')
  assert.equal(after.purchaseOrders[0].lines[0].carrier, 'UPS')
  assert.equal(after.purchaseOrders[0].lines[0].trackingNumber, '1Z222')
})
