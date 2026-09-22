import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { projectDatabase, read, save } from '../../server/tests/fixtures/project-records-database.mjs'
import { createMaterialShipment, markMaterialShipmentDelivered } from '../../src/services/materialTracking.ts'

// All persistence requests are routed to an isolated PGlite fixture database.
const { chromium } = await import(process.env.ATLAS_PLAYWRIGHT_MODULE ? pathToFileURL(path.resolve(process.env.ATLAS_PLAYWRIGHT_MODULE)).href : 'playwright')
const actor = { id: 'u1', name: 'Procurement User', role: 'Procurement Team' }
const line = (id, quantity = 1) => ({ id, clin: id, partNumber: id.toUpperCase(), manufacturer: 'Middle Atlantic', description: 'Shipment edit fixture', quantityOrdered: quantity, quantityReceived: 0, unitCost: 10, status: 'Ordered' })
const project = (id, lines) => ({ id, projectNumber: 'TEST', projectName: 'Shipment correction fixture', customer: 'Test customer', projectType: 'Resale', status: 'Active', assignedUserIds: [], governmentProjectLead: '', quotes: [], quoteLines: [], inventory: [], kitStatus: 'Ordered', shipmentStatus: 'Ordered', createdAt: '2026-09-01T12:00:00Z', purchaseOrders: [{ id: 'po1', poNumber: 'TEST-PO-1', vendor: 'Test vendor', dateIssued: '2026-09-01', status: 'Ordered', totalCost: 10, lines }], materialShipments: [], materialTrackingActivity: [] })
const ship = p => createMaterialShipment(p, { poId: 'po1', carrier: 'Other', otherCarrier: 'R&L CARRIERS INC', trackingNumber: 'AJ0761193', actualShipDate: '2026-09-10', expectedDeliveryDate: '2026-09-14', packingSlipNumber: 'PACK-1', notes: 'Original notes', lines: p.purchaseOrders[0].lines.map(l => ({ poId: 'po1', melLineItemId: l.id, quantity: l.quantityOrdered })) }, actor)
const base = ship(project('p1', [line('pfd-45a')]))
let shared = ship(project('shared', [line('a', 2), line('b', 3)]))
shared = markMaterialShipmentDelivered(shared, shared.materialShipments[0].id, '2026-09-14', actor)
const db = await projectDatabase([base, shared])
const storedBase = (await read(db, 'p1')).data, storedShared = (await read(db, 'shared')).data
const root = process.cwd(), artifacts = path.join(root, 'tmp/shipment-edit-qa')
await fs.mkdir(artifacts, { recursive: true })
await fs.writeFile(path.join(artifacts, 'index.html'), `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app" style="padding:24px"></div><script type="module">
import {createApp,h,ref} from 'vue';import {createRouter,createMemoryHistory} from 'vue-router';import Panel from '/src/components/MaterialTrackingPanel.vue';import * as projects from '/src/services/localProjects.ts';import {cacheUsers,setSession} from '/src/services/auth.ts';import '/src/style.css';
window.atlas={mount:async(id='p1',role='Procurement Team')=>{const user={id:'u1',name:'Procurement User',email:'fixture@example.invalid',role,title:'Test',active:true};cacheUsers([user]);setSession({...user,authVersion:3});await projects.refreshProjects({strict:true});const state=ref(projects.loadProject(id));const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{render:()=>null}}]});await router.push('/');await router.isReady();createApp({render:()=>h(Panel,{project:state.value,onUpdated:p=>state.value=p})}).use(router).mount('#app')}};
</script></body></html>`)
const vite = await createServer({ root, configFile: false, envFile: false, plugins: [vue(), { name: 'fixture-access-token', enforce: 'pre', transform(code, id) { if (id.replaceAll('\\', '/').endsWith('/src/services/supabaseAuth.ts')) return code.replace(/export async function getSupabaseAccessToken\(\) {[\s\S]*?\n}/, "export async function getSupabaseAccessToken() { return 'fixture-token' }") } }], define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://shipment-fixture.supabase.co'), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('fixture-key') }, server: { host: '127.0.0.1', port: 4216, strictPort: true } })
let browser, failWrite = false, holdWrite = null, writes = 0, fixtureRole = 'Procurement Team'
const checks = [], errors = []
const check = message => { checks.push(message); console.log('PASS:', message) }
try {
  await vite.listen()
  console.log('Local fixture ready')
  browser = await chromium.launch({ ...(process.env.ATLAS_BROWSER_PATH ? { executablePath: process.env.ATLAS_BROWSER_PATH } : {}), headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await context.route('https://shipment-fixture.supabase.co/**', async route => {
    const req = route.request(), url = new URL(req.url())
    const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    try {
      if (url.pathname.endsWith('/atlas_project_records')) {
        const id = url.searchParams.get('project_id')?.replace(/^eq\./, '')
        const rows = id ? [await read(db, id)] : (await db.query('select * from atlas_project_records order by project_id')).rows
        return respond(req.headers().accept?.includes('vnd.pgrst.object') ? rows[0] : rows)
      }
      if (url.pathname.endsWith('/rpc/atlas_save_project')) {
        writes++
        if (failWrite) return respond({ message: 'Fixture save unavailable', code: '57014' }, 503)
        if (holdWrite) await holdWrite
        const body = req.postDataJSON()
        return respond(await save(db, body.p_project_id, body.p_expected_revision, body.p_project, body.p_quote_id, body.p_approval_status, body.p_delete))
      }
      if (url.pathname.endsWith('/app_records') && url.searchParams.get('record_type') === 'eq.app_users') return respond({data:[{...actor,email:'fixture@example.invalid',role:fixtureRole,title:'Test',active:true}]})
      return respond([])
    } catch (error) { return respond({ message: error.message, code: error.code || 'TEST' }, 400) }
  })
  const open = async (id = 'p1', role = 'Procurement Team') => {
    fixtureRole = role
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('http://127.0.0.1:4216/tmp/shipment-edit-qa/index.html')
    await page.waitForFunction(() => window.atlas)
    await page.evaluate(([id, role]) => window.atlas.mount(id, role), [id, role])
    await page.getByRole('button', { name: 'View Shipments', exact: true }).first().click()
    return page
  }
  const page = await open()
  await page.getByRole('button', { name: 'Edit Shipment', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit Shipment', exact: true })
  for (const [label, value] of [['Carrier', 'Other'], ['Carrier Name *', 'R&L CARRIERS INC'], ['Tracking Number', 'AJ0761193'], ['Actual Ship Date *', '2026-09-10'], ['Expected Delivery Date', '2026-09-14'], ['Packing Slip Number', 'PACK-1'], ['Shipment Notes', 'Original notes']]) assert.equal(await dialog.getByLabel(label, { exact: true }).inputValue(), value)
  assert.equal(await dialog.getByRole('spinbutton').count(), 0)
  check('fully shipped item opens with all details prefilled and quantity read-only')
  await dialog.getByLabel('Carrier', { exact: true }).selectOption('FedEx')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal((await read(db, 'p1')).data.materialShipments[0].carrier, 'R&L CARRIERS INC')
  assert.equal(writes, 0)
  check('cancel leaves the saved shipment unchanged')
  await page.getByRole('button', { name: 'Edit Shipment', exact: true }).click()
  await dialog.getByLabel('Carrier', { exact: true }).selectOption('FedEx')
  await dialog.getByLabel('Tracking Number', { exact: true }).fill('123456789012')
  failWrite = true
  await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click()
  await dialog.getByRole('alert').waitFor()
  assert.equal(await dialog.getByLabel('Carrier', { exact: true }).inputValue(), 'FedEx')
  assert.equal(await dialog.getByLabel('Tracking Number', { exact: true }).inputValue(), '123456789012')
  assert.equal((await read(db, 'p1')).data.materialShipments[0].carrier, 'R&L CARRIERS INC')
  check('rejected save keeps the editor open and retains corrections for retry')
  failWrite = false
  let release
  holdWrite = new Promise(resolve => release = resolve)
  await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click()
  await dialog.getByRole('button', { name: 'Saving…', exact: true }).waitFor()
  assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true)
  assert.equal(await dialog.getByRole('button', { name: 'Close shipment details', exact: true }).isDisabled(), true)
  release(); holdWrite = null
  await dialog.waitFor({ state: 'hidden' })
  const saved = (await read(db, 'p1')).data
  assert.equal(saved.materialShipments.length, 1)
  assert.equal(saved.materialShipments[0].id, base.materialShipments[0].id)
  assert.equal(saved.materialShipments[0].carrier, 'FedEx')
  assert.deepEqual(saved.materialShipments[0].lines, storedBase.materialShipments[0].lines)
  assert.equal(saved.materialTrackingActivity.at(-1).actorName, actor.name)
  check('confirmed save updates the same shipment with quantities and history intact')
  await page.reload()
  await page.waitForFunction(() => window.atlas)
  await page.evaluate(() => window.atlas.mount())
  await page.getByRole('button', { name: 'View Shipments', exact: true }).click()
  await page.getByText('Shipment edited', { exact: true }).waitFor()
  assert.match(await page.getByRole('link', { name: '123456789012', exact: true }).first().getAttribute('href'), /fedex/)
  await page.screenshot({ path: path.join(artifacts, 'shipment-history.png'), fullPage: true })
  await page.getByRole('button', { name: 'Edit Shipment', exact: true }).click()
  assert.equal(await dialog.getByLabel('Carrier', { exact: true }).inputValue(), 'FedEx')
  await page.screenshot({ path: path.join(artifacts, 'edit-shipment.png'), fullPage: true })
  check('reload shows corrected FedEx tracking and the shipment edit activity')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Add Shipment', exact: true }).click()
  const add = page.getByRole('dialog', { name: 'Add shipment', exact: true })
  assert.equal(await add.getByLabel('Carrier', { exact: true }).inputValue(), '')
  assert.equal(await add.getByRole('button', { name: 'Save Shipment', exact: true }).count(), 1)
  check('add shipment opens a fresh form after editing')
  const sharedPage = await open('shared')
  await sharedPage.getByRole('button', { name: 'Edit Shipment', exact: true }).click()
  const sharedDialog = sharedPage.getByRole('dialog', { name: 'Edit Shipment', exact: true })
  await sharedDialog.getByText('This shipment covers 2 MEL lines. Changes apply to every item listed below.', { exact: true }).waitFor()
  assert.equal(await sharedDialog.getByRole('spinbutton').count(), 0)
  await sharedDialog.getByLabel('Carrier', { exact: true }).selectOption('FedEx')
  await sharedDialog.getByRole('button', { name: 'Save Changes', exact: true }).click()
  await sharedDialog.waitFor({ state: 'hidden' })
  const sharedSaved = (await read(db, 'shared')).data
  assert.deepEqual(sharedSaved.materialShipments[0].lines, storedShared.materialShipments[0].lines)
  assert.equal(sharedSaved.materialShipments[0].deliveredDate, '2026-09-14')
  assert.equal(sharedSaved.materialTrackingActivity.filter(a => a.action === 'Shipment edited').length, 2)
  check('shared delivered shipment shows scope and preserves delivery confirmations')
  const readOnly = await open('p1', 'Engineering')
  assert.equal(await readOnly.getByRole('button', { name: 'Edit Shipment', exact: true }).count(), 0)
  check('Engineering role cannot see the Edit Shipment action')
  assert.deepEqual(errors, [])
  await fs.writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ checks, errors }, null, 2))
  console.log(JSON.stringify({ checks, errors }, null, 2))
} catch(error) { console.error(error); throw error } finally { await browser?.close(); await vite.close(); await db.close() }
