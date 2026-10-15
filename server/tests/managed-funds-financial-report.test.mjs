import test from 'node:test'
import assert from 'node:assert/strict'
import { buildManagedFundsFinancialReport as build, validateManagedFundsFinancialReport } from '../../src/services/managedFundsFinancialReport.mjs'
import { customerReportFixture } from './fixtures/managed-funds-report.mjs'

const fixture = () => {
  const f = customerReportFixture()
  f.state.transactions.find(t => t.id === 'expense-total').kind = 'Commitment'
  f.project.purchaseOrders.forEach(p => p.lines[0].quoteLineId = 'line1')
  return f
}
const tx = values => ({authorized:0, committed:0, ...values})

test('funding ledger and approved action register reconcile with positive and negative funding adjustments', () => {
  const {project,state} = fixture(), report = build(project,state)
  assert.deepEqual(report.funding, {original:1000000,modifications:100000,authorized:1100000,committed:160607,available:939393})
  state.transactions.push(tx({kind:'Funding Modification',authorized:-20273}))
  assert.equal(build(project,state).funding.available,919120)
  validateManagedFundsFinancialReport(report)
})
test('multiple POs are displayed once per approved action without summing acquisition costs or item prices', () => {
  const {project,state} = fixture(), report = build(project,state)
  assert.equal(report.actions.length,2)
  assert.equal(report.actions[0].purchaseOrderNumbers,'PO-A\nPO-B')
  assert.equal(report.actions[0].quoteNumbers,'MF-DEMO-Q1')
  assert.equal(report.actions[0].committed,140607)
  assert.equal(report.lines[0].unitPrice,12000)
  assert.equal(report.lines[0].extendedPrice,120000)
  assert.equal(report.funding.committed,160607)
})
test('all actions are sorted numerically and unapproved actions and quotes are excluded', () => {
  const {project,state} = fixture()
  state.actions.reverse()
  state.actions.push({...state.actions.find(a=>a.id==='material'),id:'draft',number:'MF-010',status:'Draft'})
  const r = build(project,state)
  assert.deepEqual(r.actions.map(a=>a.actionNumber),['MF-001','MF-002'])
  assert.ok(!JSON.stringify(r).includes('UNAPPROVED-ALTERNATIVE'))
  state.transactions.push(tx({kind:'Commitment',actionId:'draft',committed:123}))
  assert.throws(()=>build(project,state),/no approved funded action/)
})
test('commitment releases affect the parent once; cancellations do not silently erase retained obligations', () => {
  const {project,state} = fixture()
  state.transactions.push(tx({kind:'Commitment Adjustment',actionId:'material',adjustmentActionId:'credit',committed:-40607}))
  assert.equal(build(project,state).actions[0].committed,100000)
  state.actions[0].status='Cancelled'
  const r = build(project,state)
  assert.equal(r.actions[0].status,'Cancelled'); assert.equal(r.actions[0].committed,100000)
  assert.match(r.actions[0].notes,/not been released/)
  assert.ok(!r.lines.some(l=>l.actionNumber==='MF-001'))
  state.transactions.push(tx({kind:'Cancellation',actionId:'material',committed:-100000}))
  assert.deepEqual(build(project,state).actions.map(a=>a.actionNumber),['MF-002'])
  assert.equal(build(project,state).funding.committed,20000)
})
test('missing and invalid commitment records block export instead of becoming zero', () => {
  for(const value of [undefined,null,NaN,Infinity,1.5]) {
    const {project,state}=fixture();state.transactions.find(t=>t.id==='material-total').committed=value
    assert.throws(()=>build(project,state),/missing or invalid/)
  }
  const {project,state}=fixture()
  state.transactions.push(tx({kind:'Commitment',actionId:'unknown',committed:1}))
  assert.throws(()=>build(project,state),/no approved funded action/)
})
test('unsupported legacy cost fallback and unreconciled approved records cannot endorse customer totals', () => {
  const {project,state}=fixture()
  state.transactions.find(t=>t.id==='material-total').kind='Legacy PO Mapping'
  assert.throws(()=>build(project,state),/verified customer commitment/)
  project.purchaseOrders.forEach(p=>p.customerTotalCost=600)
  assert.equal(build(project,state).funding.committed,160607)
  state.originalFunding++
  assert.throws(()=>build(project,state),/Original funding does not reconcile/)
})
test('missing item prices stay unavailable without leaking preparer labels or inferring supplier price', () => {
  const {project,state}=fixture()
  delete project.quotes[0].lines[0].unitCost
  const r=build(project,state)
  assert.equal(r.lines.length,0);assert.equal(r.funding.committed,160607)
  assert.match(r.notes.join(' '),/details are omitted/)
  assert.ok(!JSON.stringify(r).includes('Price needed'))
})
test('zero-dollar configuration components are explicitly included under supported priced equipment', () => {
  const {project,state}=fixture()
  project.quotes[0].lines.push({...project.quotes[0].lines[0],id:'component',description:'Power cord',unitCost:0,noCost:true,quantity:1})
  project.purchaseOrders[0].lines.push({id:'cord',quoteLineId:'component',quantityOrdered:1})
  const r=build(project,state), included=r.lines.find(l=>l.partNumber==='SW-24P'&&l.unitPrice===0)
  assert.equal(included.included,true);assert.match(included.description,/included in priced configuration/)
  assert.equal(r.funding.committed,160607)
})
test('status follows actual PO lines and shipments; cancelled POs do not mask active delivery', () => {
  const {project,state}=fixture()
  assert.equal(build(project,state).actions[0].status,'PO Issued')
  project.purchaseOrders.forEach(p=>p.lines.forEach(l=>l.status='Delivered'))
  assert.equal(build(project,state).actions[0].status,'Delivered')
  project.purchaseOrders[0].status='Cancelled'
  project.purchaseOrders[0].lines[0].status='Ordered'
  assert.equal(build(project,state).actions[0].status,'Delivered')
  project.purchaseOrders[1].lines[0].status='In Transit'
  assert.equal(build(project,state).actions[0].status,'In Transit')
  project.purchaseOrders=[]
  assert.equal(build(project,state).actions[0].status,'Processing')
})
test('customer DTO uses an exact allowlist and sanitizes embedded supplier identities while retaining product manufacturers', () => {
  const {project,state}=fixture()
  state.actions[0].description='Example Network switch from PRIVATE_VENDOR_NAME'
  project.purchaseOrders[0].poNumber='PO-A-PRIVATE_VENDOR_NAME'
  project.purchaseOrders[0].customerUpdateNotes='Delivery expected next week. Internal margin 25%. Invoice paid.'
  project.quotes[0].lines[0].description='Example Network switch. Vendor account #1234. Price needed PO-TOTAL'
  const r=build(project,state), encoded=JSON.stringify(r)
  assert.deepEqual(Object.keys(r),['customer','projectNumber','projectName','generatedAt','funding','actions','lines','notes'])
  assert.deepEqual(Object.keys(r.actions[0]),['actionNumber','description','quoteNumbers','purchaseOrderNumbers','status','committed','notes'])
  assert.deepEqual(Object.keys(r.lines[0]),['actionNumber','partNumber','manufacturer','description','quantity','unitPrice','extendedPrice','included'])
  for(const term of ['PRIVATE_','unitCost','actualCost','margin','markup','invoice','payment','billing','PO-TOTAL','Price needed','revision','owner','audit']) assert.ok(!encoded.toLowerCase().includes(term.toLowerCase()),term)
  assert.match(r.actions[0].description,/Example Network/)
  assert.equal(r.lines[0].manufacturer,'Example Network')
  assert.equal(r.actions[0].purchaseOrderNumbers,'PO-A\nPO-B')
})
test('empty reports retain real project funding with no invented purchases; building is read-only', () => {
  const f=fixture();f.state.actions=[];f.state.transactions=f.state.transactions.slice(0,2);f.project.quotes=[];f.project.purchaseOrders=[]
  const before=structuredClone(f),r=build(f.project,f.state)
  assert.equal(r.actions.length,0);assert.equal(r.lines.length,0);assert.equal(r.funding.committed,0);assert.equal(r.funding.available,1100000)
  assert.deepEqual(f,before)
})
test('tampering with an export projection fails a second reconciliation before workbook creation', () => {
  const f=fixture(),r=build(f.project,f.state);r.funding.available++
  assert.throws(()=>validateManagedFundsFinancialReport(r),/cannot be reconciled/)
})
test('supplier spellings with spaces, hyphens, punctuation or joined words are removed from references', () => {
  const {project,state}=fixture()
  state.actions[0].vendors=['Accutech','Home Depot','Data Interfaces','3DB Labs']
  project.purchaseOrders[0].vendor='Accutech';project.purchaseOrders[0].poNumber='25-100-0008-Accu-Tech'
  project.purchaseOrders[1].vendor='Data Interfaces';project.purchaseOrders[1].poNumber='25-100-0009-DataInterfaces'
  state.actions[0].description='Switches — HomeDepot'
  project.projectName='Customer network (MANAGED FUNDS IN QBO - private accounting name)'
  const r=build(project,state)
  assert.equal(r.actions[0].purchaseOrderNumbers,'25-100-0008\n25-100-0009')
  assert.equal(r.actions[0].description,'Switches')
  assert.equal(r.projectName,'Customer network')
})
test('detail quantities come from linked orders, not planned quote quantities; unsupported quantities are omitted', () => {
  const {project,state}=fixture()
  project.purchaseOrders[1].lines[0].quantityOrdered=2
  assert.equal(build(project,state).lines[0].quantity,7)
  assert.equal(build(project,state).lines[0].extendedPrice,84000)
  assert.equal(build(project,state).funding.committed,160607)
  delete project.purchaseOrders[0].lines[0].quantityOrdered
  assert.equal(build(project,state).lines.length,0)
})
