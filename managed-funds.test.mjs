import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { applyManagedFundsCommand as apply, initializeManagedFunds, financialSummary, actionFinancials, billingStatus, reconcileManagedProject, procurementStatus, cents, canManageFunds } from '../../src/domain/managedFunds.mjs'
import { generateVendorPurchaseOrders, calculateQuoteSummary } from '../../src/services/calculations.ts'
import { createMaterialShipment, markMaterialShipmentDelivered } from '../../src/services/materialTracking.ts'
import { handleManagedFundsApi } from '../managed-funds-api.mjs'

const admin = { id:'admin1',name:'Finance Admin',role:'admin' }, buyer = { id:'buyer1',name:'Procurement',role:'procurement' }
const base = (type='Managed Funds') => ({ id:'project1',projectType:type,projectNumber:'26-087',projectName:'CCoE FY27 Managed Funds',customer:'CCoE',customerAddress1:'123 Customer St',customerCity:'Augusta',customerState:'GA',customerZip:'30901',checkbookStartingBalance:1_000_000,quotes:[],quoteLines:[],purchaseOrders:[],materialShipments:[],materialTrackingActivity:[],inventory:[],notes:'Original project notes',legacyDocuments:[{id:'doc1',name:'Original authorization.pdf'}] })
const command = (type,input={},actionId) => ({id:randomUUID(),type,input,...(actionId?{actionId}:{})})
const run = (state,type,input={},actionId,actor=admin,options={}) => apply(state,command(type,input,actionId),actor,options)
function create(state,type='Purchase Material',description='Network equipment',bill=100_000,cost=80_000) {
  const next=run(state,'create',{type,description,authorizedAmount:cents(bill),estimatedCost:cents(cost),billAmount:cents(bill),requestDate:'2026-09-14',requestor:'Customer',vendors:['Vendor A','Vendor B']},undefined,buyer)
  return [next,next.actions.at(-1).id]
}
function approved(state,id,amount) { return run(state,'approve',{commitment:cents(amount),reason:'Customer authorization verified'},id,buyer) }

test('complete Managed Funds material, expense, consolidated billing, credits and modification workflow',()=>{
  let {state,project}=initializeManagedFunds(base(),admin)
  assert.equal(financialSummary(state).authorized,cents(1_000_000))
  let id; [state,id]=create(state); state=approved(state,id,100_000)
  const lines=['Vendor A','Vendor B'].map((vendor,index)=>({id:`l${index}`,clin:String(index+1),partNumber:`PART-${index}`,manufacturer:'Cisco',description:'Network equipment',quantity:1,unitCost:index?40_000:30_000,markupPercent:25,vendor,quoteNumber:`VQ-${index}`,leadTime:'2 weeks',approved:true}))
  const quote={id:'q1',actionId:id,quoteNumber:'Q-26-184',projectId:project.id,projectNumber:project.projectNumber,projectName:project.projectName,customer:project.customer,status:'Customer Approved',createdAt:'2026-09-14',lines}
  ;({state,project}=reconcileManagedProject(state,project,{...project,quotes:[quote]},{id:'other-buyer',name:'Other Procurement Member',role:'Procurement Team'}))
  const pos=generateVendorPurchaseOrders(lines,project.projectNumber).map(p=>({...p,quoteId:quote.id,actionId:id}))
  assert.equal(pos.length,2)
  ;({state,project}=reconcileManagedProject(state,project,{...project,purchaseOrders:pos},buyer))
  assert.equal(state.actions.find(a=>a.id===id).poIds.length,2)
  let tracked=project
  for(const po of project.purchaseOrders) {
    tracked=createMaterialShipment(tracked,{poId:po.id,carrier:'UPS',trackingNumber:`1Z-${po.id}`,actualShipDate:'2026-09-14',lines:po.lines.map(l=>({poId:po.id,melLineItemId:l.id,quantity:l.quantityOrdered}))},{...buyer,role:'Procurement Team'})
    tracked=markMaterialShipmentDelivered(tracked,tracked.materialShipments.at(-1).id,'2026-09-15',{...buyer,role:'Procurement Team'})
  }
  ;({state,project}=reconcileManagedProject(state,project,tracked,buyer))
  assert.equal(procurementStatus(project,state.actions[0]),'Delivered')
  state=run(state,'expense',{vendor:'Vendor A',vendorInvoiceNumber:'VA-001',description:'Equipment cost',expenseDate:'2026-09-14',actualCost:cents(30_000),billAmount:0},id,buyer)
  state=run(state,'expense',{vendor:'Vendor B',vendorInvoiceNumber:'VB-001',description:'Equipment cost',expenseDate:'2026-09-14',actualCost:cents(40_000),billAmount:0},id,buyer)
  state=run(state,'ready',{ready:true},id,buyer)
  state=run(state,'draft_invoice',{projectNumber:project.projectNumber,allocations:[{actionId:id,amount:cents(100_000)}]},undefined,buyer,{project})
  const materialInvoice=state.invoices.at(-1).id
  assert.equal(state.invoices.at(-1).customerSnapshot.customer,'CCoE')
  state=run(state,'issue_invoice',{invoiceId:materialInvoice},undefined,buyer)
  assert.equal(billingStatus(state,state.actions[0]),'Invoiced')
  let truck; [state,truck]=create(state,'Direct Expense / Pass-Through','Truck rental',1200,1000); state=approved(state,truck,1200)
  state=run(state,'document',{name:'Truck rental.pdf',storagePath:`${project.id}/${truck}/receipt.pdf`,size:1000,kind:'Vendor invoice / receipt'},truck,buyer)
  state=run(state,'expense',{vendor:'Truck Rental',vendorInvoiceNumber:'TR-001',description:'Truck rental',expenseDate:'2026-09-14',actualCost:cents(1000),billAmount:cents(1200),documentId:state.documents.at(-1).id},truck,buyer)
  assert.equal(state.actions.find(a=>a.id===truck).quoteIds.length,0)
  state=run(state,'ready',{ready:true},truck,buyer)
  let billing; [state,billing]=create(state,'Create Customer Invoice','Standalone billing',5000,0); state=approved(state,billing,5000); state=run(state,'ready',{ready:true},billing,buyer)
  state=run(state,'draft_invoice',{allocations:[{actionId:truck,amount:cents(1200)},{actionId:billing,amount:cents(5000)}]},undefined,buyer)
  const consolidated=state.invoices.at(-1); assert.equal(consolidated.allocations.length,2)
  state=run(state,'issue_invoice',{invoiceId:consolidated.id},undefined,buyer)
  const adjustment=description=>{state=run(state,'create',{type:'Credit / Adjustment',description});return state.actions.at(-1).id}
  const customerCredit=adjustment('Customer pricing credit')
  state=run(state,'adjust',{kind:'Customer Credit',targetActionId:truck,invoiceId:consolidated.id,amount:cents(-200),reason:'Rental pricing correction',reference:'CC-001'},customerCredit)
  const vendorCredit=adjustment('Vendor rental credit')
  state=run(state,'adjust',{kind:'Vendor Credit',targetActionId:truck,amount:cents(-100),reason:'Vendor refund',reference:'VC-001'},vendorCredit)
  for(const [n,value] of [[1,500_000],[2,-100_000]]) {
    state=run(state,'create',{type:'Funding Modification',description:`Modification ${n}`})
    state=run(state,'funding',{amount:cents(value),reference:`MOD-${n}`,reason:'Signed customer modification'},state.actions.at(-1).id)
  }
  assert.deepEqual(financialSummary(state),{authorized:cents(1_400_000),committed:cents(106_200),actualCost:cents(70_900),billAmount:cents(106_000),invoiced:cents(106_000),paid:0,available:cents(1_293_800),unbilled:cents(1_294_000)})
  assert.equal(actionFinancials(state,truck).billable,0,'credit does not silently make refunded amount billable again')
  const priorTransactions=structuredClone(state.transactions)
  state=run(state,'payment',{invoiceId:consolidated.id,amount:cents(6000),reference:'ACH-001'},undefined,buyer)
  assert.equal(financialSummary(state).paid,cents(6000))
  assert.deepEqual(state.transactions.slice(0,priorTransactions.length),priorTransactions)
  assert.ok(state.audit.every(a=>a.userId&&a.occurredAt&&'previous'in a&&'next'in a))
})

test('over-commitment and funding decreases are controlled, including mandatory override explanations',()=>{
  let {state}=initializeManagedFunds(base(),admin);let id;[state,id]=create(state,'Purchase Material','Over budget',1_100_000)
  assert.throws(()=>approved(state,id,1_100_000),e=>e.message==='Insufficient Available Funding'&&e.details.projectedRemainingBalance===cents(-100_000))
  assert.throws(()=>run(state,'approve',{commitment:cents(1_100_000),reason:'Requested',overrideReason:'Management authorized'},id,buyer),e=>e.status===409&&e.message==='Insufficient Available Funding')
  state=run(state,'approve',{commitment:cents(1_100_000),reason:'Approved',overrideReason:'Management funding exception 27'},id)
  assert.ok(state.audit.some(a=>a.operation==='Funding limit override'&&a.reason==='Management funding exception 27'))
  state=run(state,'create',{type:'Funding Modification',description:'Decrease'})
  assert.throws(()=>run(state,'funding',{amount:cents(-100),reference:'MOD',reason:'Decrease'},state.actions.at(-1).id),/Insufficient/)
})
test('all procurement members can approve and issue POs while other financial permissions remain restricted',()=>{
  for(const role of ['engineering','sales']) for(const p of ['approve','funding','adjust','override']) assert.equal(canManageFunds({id:'u',role},p),false)
  for(const role of ['procurement','Procurement Team']) {
    for(const permission of ['approve','issue_po']) assert.equal(canManageFunds({id:'u',role},permission),true)
    for(const permission of ['funding','adjust','override']) assert.equal(canManageFunds({id:'u',role},permission),false)
  }
  assert.equal(canManageFunds(buyer,'expense'),true);assert.equal(canManageFunds({id:'sales',role:'sales'},'invoice'),true);assert.equal(canManageFunds({id:'sales',role:'sales'},'issue_po'),false)
  assert.equal(canManageFunds({...buyer,permissions:['atlas.managed_funds.approve']},'approve'),true)
})
test('draft reservations, re-issue, payment replay and cross-project allocation guards prevent duplicate billing',()=>{
  let {state}=initializeManagedFunds(base(),admin);let id;[state,id]=create(state);state=approved(state,id,100_000);state=run(state,'ready',{ready:true},id)
  assert.throws(()=>run(state,'draft_invoice',{allocations:[{actionId:'another-project-action',amount:100}]}),/Ready to Bill/)
  assert.throws(()=>run(state,'draft_invoice',{allocations:[{actionId:id,amount:100},{actionId:id,amount:100}]}),/once/)
  state=run(state,'draft_invoice',{allocations:[{actionId:id,amount:cents(100_000)}]})
  assert.throws(()=>run(state,'draft_invoice',{allocations:[{actionId:id,amount:1}]}),/Duplicate or excess/)
  assert.throws(()=>run(state,'edit',{billAmount:0,reason:'Reduce'},id),/issued and reserved/)
  const invoice=state.invoices[0]
  state=run(state,'issue_invoice',{invoiceId:invoice.id});assert.throws(()=>run(state,'issue_invoice',{invoiceId:invoice.id}),/already/)
  state=run(state,'payment',{invoiceId:invoice.id,amount:cents(100_000),reference:'PAY-1'});assert.throws(()=>run(state,'payment',{invoiceId:invoice.id,amount:1,reference:'PAY-1'}),/already/)
  assert.equal(billingStatus(state,state.actions[0]),'Paid')
})
test('idempotent command retry returns unchanged state and conflicting reuse fails',()=>{
  const {state}=initializeManagedFunds(base(),admin),cmd=command('create',{type:'Purchase Material',description:'Single action'})
  const once=apply(state,cmd,buyer),twice=apply(once,cmd,buyer)
  assert.deepEqual(twice,once);assert.throws(()=>apply(once,{...cmd,input:{...cmd.input,description:'Different'}},buyer),/already used/)
  assert.throws(()=>apply(once,cmd,admin),/already used/)
})
test('PO and expense costs cannot exceed approved commitments, and Sales cannot update tracking',()=>{
  let {state,project}=initializeManagedFunds(base(),admin);let id;[state,id]=create(state,'Purchase Material','Controlled purchase',100,80);state=approved(state,id,100)
  assert.throws(()=>run(state,'expense',{vendor:'Vendor',vendorInvoiceNumber:'EXCESS',description:'Overrun',expenseDate:'2026-09-14',actualCost:cents(101),billAmount:0},id,buyer),/exceeds the Action commitment/)
  const po={id:'new-po',actionId:id,poNumber:'PO-001',vendor:'Vendor',status:'PO Generated',totalCost:101,lines:[{id:'line',quantityOrdered:1,unitCost:101,quantityReceived:0,status:'Ordered'}]}
  assert.throws(()=>reconcileManagedProject(state,project,{...project,purchaseOrders:[po]},buyer),/PO costs exceed/)
  assert.throws(()=>reconcileManagedProject(state,project,{...project,materialShipments:[{id:'forged'}]},{id:'sales',role:'sales'}),/issue_po/)
})
test('closed Actions retain notes and adjustment Actions expose their financial impact',()=>{
  let {state}=initializeManagedFunds(base(),admin);let id;[state,id]=create(state,'Direct Expense / Pass-Through','Rental',100,80);state=approved(state,id,100)
  state=run(state,'expense',{vendor:'Rental',vendorInvoiceNumber:'RENT',description:'Rental cost',expenseDate:'2026-09-14',actualCost:cents(80),billAmount:cents(100)},id)
  state=run(state,'status',{status:'Complete'},id)
  state=run(state,'note',{note:'Final receipt verified.'},id,buyer)
  assert.ok(state.actions[0].notes.includes('Final receipt verified.'))
  state=run(state,'create',{type:'Credit / Adjustment',description:'Vendor refund'})
  const adjustment=state.actions.at(-1).id
  state=run(state,'adjust',{kind:'Vendor Credit',targetActionId:id,amount:cents(-10),reason:'Rental refund',reference:'CREDIT-1'},adjustment)
  assert.equal(actionFinancials(state,adjustment).actualCost,cents(-10))
  assert.equal(financialSummary(state).actualCost,cents(70),'project totals count each transaction once')
})
test('legacy migration preserves source fields and relationships without guessing incurred costs or invoices',()=>{
  const original=base('Checkbook');original.invoices=[{id:'legacy-invoice',total:400}];original.checkbookRemainingBalance=12345
  original.quotes=[{id:'quote1',quoteNumber:'Q1',quoteName:'Legacy quote',status:'Customer Approved',createdAt:'2020-01-01',lines:[{id:'line1',quantity:1,unitCost:100,markupPercent:20}]}]
  original.purchaseOrders=[{id:'po1',poNumber:'PO-1',quoteId:'quote1',totalCost:100,lines:[{id:'po-line1',quantityOrdered:1,quantityReceived:1,trackingNumber:'TRACK',unitCost:100}]},{id:'po2',poNumber:'PO-2',totalCost:20,customerTotalCost:25,lines:[]}]
  original.materialTrackingActivity=[{id:'history1',action:'Received original material'}]
  const untouched=structuredClone(original),{state,project}=initializeManagedFunds(original,admin)
  assert.deepEqual(original,untouched);assert.equal(project.projectType,'Managed Funds');assert.equal(project.projectNumber,original.projectNumber)
  for(const key of ['invoices','legacyDocuments','materialTrackingActivity','checkbookStartingBalance','checkbookRemainingBalance','notes'])assert.deepEqual(project[key],original[key])
  assert.equal(state.actions.length,2);assert.equal(project.quotes[0].actionId,project.purchaseOrders[0].actionId)
  assert.equal(project.purchaseOrders[0].lines[0].trackingNumber,'TRACK')
  assert.equal(financialSummary(state).committed,cents(145));assert.equal(financialSummary(state).actualCost,0);assert.equal(financialSummary(state).invoiced,0)
  assert.ok(state.review.some(r=>r.recordType==='invoices'));assert.ok(state.review.some(r=>r.recordType==='checkbookRemainingBalance'))
})
test('action numbering is unique within each project and cancellation never reuses a number',()=>{
  let {state}=initializeManagedFunds(base(),admin)
  for(let n=0;n<120;n++){let id;[state,id]=create(state,'Purchase Material',`Action ${n}`);if(n===0)state=run(state,'cancel',{reason:'No longer needed'},id)}
  assert.equal(new Set(state.actions.map(a=>a.number)).size,120);assert.equal(state.actions[119].number,'MF-120')
  const other=initializeManagedFunds({...base(),id:'project2'},admin);const [otherState]=create(other.state);assert.equal(otherState.actions[0].number,'MF-001')
})
test('financial validation rejects malformed money, negative expenses and forged documents',()=>{
  for(const n of [NaN,Infinity,'banana',null,''])assert.throws(()=>cents(n),/valid/)
  let {state}=initializeManagedFunds(base(),admin);let id;[state,id]=create(state);state=approved(state,id,100_000)
  assert.throws(()=>run(state,'expense',{actualCost:-1},id),/integer cents/)
  assert.throws(()=>run(state,'document',{name:'receipt',storagePath:'other-project/file'},id),/storage path/)
  const expense={vendor:'A',vendorInvoiceNumber:'A-1',description:'Cost',expenseDate:'2026-02-31',actualCost:100,billAmount:0}
  assert.throws(()=>run(state,'expense',expense,id),/valid date/)
  state=run(state,'expense',{...expense,expenseDate:'2026-09-14'},id)
  assert.throws(()=>run(state,'expense',{...expense,expenseDate:'2026-09-14'},id),/already recorded/)
  assert.throws(()=>run(state,'cancel',{reason:'Delete history'},id),/history cannot/)
})
test('existing project modules retain Resale and Design & Install calculations and vendor grouping',()=>{
  for(const type of ['Resale','Design & Install']) {
    const project=base(type),snapshot=structuredClone(project)
    assert.throws(()=>initializeManagedFunds(project,admin),/not a Managed Funds/)
    const lines=[{id:'a',clin:'1',description:'Part A',partNumber:'A',quantity:2,unitCost:10,markupPercent:20,approved:true,vendor:'A'},{id:'b',clin:'2',description:'Part B',partNumber:'B',quantity:3,unitCost:20,markupPercent:25,approved:true,vendor:'B'}]
    const summary=calculateQuoteSummary(lines,true,5)
    assert.equal(summary.totalCost,80);assert.equal(summary.totalSellPrice,99);assert.equal(generateVendorPurchaseOrders(lines,'P').length,2)
    assert.deepEqual(project,snapshot)
  }
})

class MemoryRepository {
  constructor(project,state){this.p=structuredClone(project);this.s=structuredClone(state);this.s.revision=1}
  async load(){return {project:structuredClone(this.p),state:structuredClone(this.s)}}
  async project(){return structuredClone(this.p)}
  async state(){return structuredClone(this.s)}
  async commit(id,old,project,state,revision){if(revision!==this.s.revision){const e=new Error('Revision conflict');e.status=409;throw e}this.p=structuredClone(project);this.s={...structuredClone(state),revision:revision+1}}
}
async function api(repo,body,options={}) {
  const result={};const authUser={id:admin.id,email:'admin@example.test',app_metadata:options.metadata||{atlas_role:'admin'},user_metadata:{role:'admin'}}
  const supabase={auth:{getUser:async()=>({data:{user:authUser}})},storage:options.storage}
  await handleManagedFundsApi({request:{method:options.method||'POST',headers:{authorization:options.unauthorized?'':'Bearer test'},url:options.url||'/api/managed-funds/project1/commands'},response:{},pathname:options.path||'/api/managed-funds/project1/commands',sendJson:(_,status,data)=>Object.assign(result,{status,data}),readJsonBody:async()=>structuredClone(body),readBufferBody:async()=>Buffer.from('test receipt'),supabase,repository:repo})
  return result
}
test('API rejects unauthenticated requests and user-editable metadata cannot elevate financial permissions',async()=>{
  const initial=initializeManagedFunds(base(),admin),repo=new MemoryRepository(initial.project,initial.state)
  assert.equal((await api(repo,{}, {unauthorized:true})).status,401)
  const result=await api(repo,{revision:1,command:command('create',{type:'Funding Modification',description:'Unauthorized'})},{metadata:{}})
  assert.equal(result.status,403)
})
test('concurrent API commands have one winner and stale state cannot overwrite the ledger',async()=>{
  const initial=initializeManagedFunds(base(),admin),repo=new MemoryRepository(initial.project,initial.state)
  const commands=[command('create',{type:'Purchase Material',description:'A'}),command('create',{type:'Purchase Material',description:'B'})]
  const results=await Promise.all(commands.map(c=>api(repo,{revision:1,command:c})))
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(repo.s.actions.length,1)
  const winning=commands[results.findIndex(r=>r.status===200)]
  assert.equal((await api(repo,{revision:1,command:winning})).status,200);assert.equal(repo.s.actions.length,1)
})
test('upload uses a private project/action storage path, persists metadata, and forbids forged metadata commands',async()=>{
  const initial=initializeManagedFunds(base(),admin);const [state,id]=create(initial.state,'Direct Expense / Pass-Through','Truck rental')
  const repo=new MemoryRepository(initial.project,state),uploaded=[]
  const storage={from:bucket=>{assert.equal(bucket,'atlas-managed-funds');return{upload:async(path,buffer)=>{uploaded.push(path);assert.equal(buffer.toString(),'test receipt');return{}},remove:async()=>({})}}}
  const result=await api(repo,{}, {path:'/api/managed-funds/project1/documents',url:`/api/managed-funds/project1/documents?actionId=${id}&revision=1&name=invoice.pdf`,storage})
  assert.equal(result.status,201);assert.equal(repo.s.documents.length,1);assert.ok(uploaded[0].startsWith(`project1/${id}/`))
  assert.equal((await api(repo,{revision:2,command:command('document',{name:'forged',storagePath:`project1/${id}/fake.pdf`},id)})).status,400)
})

test('completed material and expense actions accept late costs without reopening or changing customer balances',()=>{
  for (const type of ['Purchase Material','Direct Expense / Pass-Through']) {
    let {state}=initializeManagedFunds(base(),admin),id
    ;[state,id]=create(state,type,'Completed work',100,80)
    state=approved(state,id,100)
    state=run(state,'status',{status:'Complete'},id)
    const before=structuredClone(state), input={vendor:'Vendor A',vendorInvoiceNumber:'LATE-1',description:'Final vendor invoice',expenseDate:'2026-10-28',actualCost:cents(60),billAmount:cents(100)}
    const cmd=command('expense',input,id)
    state=apply(state,cmd,buyer)
    assert.equal(state.actions.find(a=>a.id===id).status,'Complete')
    assert.deepEqual(state.transactions.slice(0,-1),before.transactions)
    assert.deepEqual(apply(state,cmd,buyer),state,'retry does not double-post')
    assert.equal(state.audit.at(-1).previous.status,'Complete')
    assert.equal(state.audit.at(-1).next.status,'Complete')
    assert.equal(actionFinancials(state,id).actualCost,cents(60))
    for(const field of ['authorized','committed','billAmount','invoiced','paid']) assert.equal(financialSummary(state)[field],financialSummary(before)[field],field)
    assert.throws(()=>run(state,'expense',input,id,buyer),/already recorded/)
    assert.throws(()=>run(state,'expense',{...input,vendorInvoiceNumber:'OVER',actualCost:cents(41)},id,buyer),/exceeds the Action commitment/)
    assert.throws(()=>run(state,'expense',{...input,vendorInvoiceNumber:'NO'},id,{id:'viewer',role:'viewer'}),/Permission required/)
    assert.throws(()=>run({...before,actions:before.actions.map(a=>({...a,status:'Cancelled'}))},'expense',input,id,buyer),/Approve/)
    assert.deepEqual(before.transactions,state.transactions.slice(0,-1))
  }
})

