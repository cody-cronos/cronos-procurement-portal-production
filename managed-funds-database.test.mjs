import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { initializeManagedFunds,applyManagedFundsCommand } from '../../src/domain/managedFunds.mjs'

test('real PostgreSQL migration, atomic commit, permissions, history protection, rollback and rerun',async()=>{
  const db=new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;create role supabase_admin;
      create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
      create table app_records(record_type text,record_key text,data jsonb,updated_at timestamptz default now(),unique(record_type,record_key));
      grant usage on schema public to anon,authenticated,service_role;grant select,insert,update,delete on app_records to anon,authenticated,service_role;`)
    const original={id:'legacy1',projectType:'Checkbook',projectNumber:'26-087',customer:'CCoE',checkbookStartingBalance:1000000,quotes:[],purchaseOrders:[],legacyInvoices:[{id:'INV-1',amount:123}],notes:'Keep original history'}
    const standard={id:'resale1',projectType:'Resale',projectNumber:'26-090'}
    await db.query("insert into app_records values('projects','all',$1,now())",[JSON.stringify([original,standard])])
    const migration=readFileSync(new URL('../../migrations/20260914_create_managed_funds.sql',import.meta.url),'utf8')
    await db.exec(migration)
    let records=(await db.query("select data from app_records where record_type='projects'")).rows[0].data
    assert.equal(records[0].projectType,'Managed Funds')
    assert.deepEqual((await db.query('select source from atlas_managed_funds_legacy_backups')).rows[0].source,original)
    const actor={id:'admin1',name:'Admin',role:'admin'},initial=initializeManagedFunds(records[0],actor)
    const commit=async(previous,project,state,revision)=>db.query('select atlas_commit_managed_funds($1,$2,$3,$4,$5) as result',[project.id,revision,JSON.stringify(previous),JSON.stringify(project),JSON.stringify(state)])
    await db.exec('set role anon')
    await assert.rejects(()=>commit(records[0],initial.project,initial.state,-1),/permission denied/)
    await assert.rejects(()=>db.query('select * from atlas_managed_funds'),/permission denied/)
    await assert.rejects(()=>db.query("update app_records set data='[]' where record_type='projects'"),/Managed Funds/)
    await db.exec('reset role;set role service_role')
    await commit(records[0],initial.project,initial.state,-1)
    await db.exec('reset role')
    let state=(await db.query('select state from atlas_managed_funds')).rows[0].state
    records=(await db.query("select data from app_records where record_type='projects'")).rows[0].data
    let project=records.find(p=>p.id==='legacy1')
    state=applyManagedFundsCommand(state,{id:'cmd1',type:'create',input:{type:'Create Customer Invoice',description:'Standalone bill',authorizedAmount:10000,billAmount:10000}},actor)
    await commit(project,project,state,1)
    await assert.rejects(()=>commit(project,project,state,1),/conflict/)
    state=(await db.query('select state from atlas_managed_funds')).rows[0].state
    project=(await db.query("select data from app_records where record_type='projects'")).rows[0].data.find(p=>p.id==='legacy1')
    const mutilated={...state,transactions:[]}
    await assert.rejects(()=>commit(project,project,mutilated,2),/append-only/)
    await assert.rejects(()=>db.exec("update atlas_managed_funds_transactions set data='{}'"),/append-only/)
    await assert.rejects(()=>db.exec('delete from atlas_managed_funds_audit'),/append-only/)
    await db.exec('set role anon')
    const merged=await db.query('select atlas_merge_standard_projects($1) as projects',[JSON.stringify([{...standard,projectNumber:'26-091'}])])
    assert.equal(merged.rows[0].projects.find(p=>p.id==='legacy1').managedFundsRevision,2)
    assert.equal(merged.rows[0].projects.find(p=>p.id==='resale1').projectNumber,'26-091')
    await assert.rejects(()=>db.query('select atlas_merge_standard_projects($1)',[JSON.stringify([{...project,checkbookStartingBalance:0}])]),/authenticated API/)
    await db.exec('reset role')
    const id=state.actions[0].id
    for (const cmd of [{id:'approve',type:'approve',actionId:id,input:{commitment:10000,reason:'Customer approved'}},{id:'ready',type:'ready',actionId:id,input:{ready:true}},{id:'draft',type:'draft_invoice',input:{allocations:[{actionId:id,amount:10000}]}}]) state=applyManagedFundsCommand(state,cmd,actor)
    await commit(project,project,state,2)
    state=(await db.query('select state from atlas_managed_funds')).rows[0].state
    project=(await db.query("select data from app_records where record_type='projects'")).rows[0].data.find(p=>p.id==='legacy1')
    assert.equal((await db.query('select * from atlas_managed_funds_invoice_allocations')).rows.length,1)
    state=applyManagedFundsCommand(state,{id:'issue',type:'issue_invoice',input:{invoiceId:state.invoices[0].id}},actor)
    await commit(project,project,state,3)
    assert.equal(Number((await db.query("select sum((data->>'invoiced')::bigint) as invoiced from atlas_managed_funds_transactions")).rows[0].invoiced),10000)
    // Persist completion before a late vendor invoice; neither posting reopens it.
    state=(await db.query('select state from atlas_managed_funds')).rows[0].state
    project=(await db.query("select data from app_records where record_type='projects'")).rows[0].data.find(p=>p.id==='legacy1')
    state=applyManagedFundsCommand(state,{id:'late-create',type:'create',input:{type:'Direct Expense / Pass-Through',description:'Completed deposit',authorizedAmount:50000,billAmount:50000}},actor)
    const lateId=state.actions.at(-1).id
    state=applyManagedFundsCommand(state,{id:'late-approve',type:'approve',actionId:lateId,input:{commitment:50000,reason:'Customer approved'}},actor)
    state=applyManagedFundsCommand(state,{id:'late-complete',type:'status',actionId:lateId,input:{status:'Complete'}},actor)
    await commit(project,project,state,4)
    state=(await db.query('select state from atlas_managed_funds')).rows[0].state
    project=(await db.query("select data from app_records where record_type='projects'")).rows[0].data.find(p=>p.id==='legacy1')
    const history=structuredClone(state.transactions)
    state=applyManagedFundsCommand(state,{id:'late-cost',type:'expense',actionId:lateId,input:{vendor:'Supplier',vendorInvoiceNumber:'FINAL-1',description:'Final deposit invoice',expenseDate:'2026-10-28',actualCost:45000,billAmount:50000}},{id:'buyer',role:'procurement'})
    await commit(project,project,state,5)
    const persisted=(await db.query('select state from atlas_managed_funds')).rows[0].state
    assert.equal(persisted.actions.find(a=>a.id===lateId).status,'Complete')
    assert.equal(persisted.transactions.at(-1).actualCost,45000)
    assert.deepEqual(persisted.transactions.slice(0,-1),history)
    await db.exec(migration)
    assert.equal((await db.query('select revision from atlas_managed_funds')).rows[0].revision,6)
    await db.exec(readFileSync(new URL('../../migrations/20260914_managed_funds_rollback.sql',import.meta.url),'utf8'))
    assert.equal((await db.query("select data from app_records where record_type='projects'")).rows[0].data.find(p=>p.id==='legacy1').projectType,'Managed Funds')
    assert.equal((await db.query('select count(*) as n from atlas_managed_funds_legacy_backups')).rows[0].n,1)
  } finally { await db.close() }
})
