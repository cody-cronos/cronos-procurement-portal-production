import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import JSZip from 'jszip'
import XLSX from 'xlsx'
import { customerReportFixture } from './fixtures/managed-funds-report.mjs'

test('actual customer exporter creates two reconciled sheets and a separate equipment workbook', async () => {
  const output = await fs.mkdtemp(path.resolve('tmp/customer-workbook-'))
  const bundle = path.join(output, 'exporters.mjs')
  await build({ stdin: { contents: "export * from './src/services/customerFinancialExports.ts'; export * from './src/services/managedFundsFinancialReport.mjs'", resolveDir: process.cwd() }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', define: { 'import.meta.env': '{}' }, logLevel: 'silent' })
  const api = await import(pathToFileURL(bundle).href)
  const { project, state } = customerReportFixture()
  state.transactions.find(t => t.id === 'expense-total').kind = 'Commitment'
  state.actions[1].vendors = ['AccessNsite']
  state.actions[1].description = 'AccessNsite Deposit'
  state.actions[0].description = 'Network equipment & configuration quote — PO-A\n' + 'Approved equipment configuration '.repeat(8)
  project.purchaseOrders.forEach(po => { po.lines[0].quoteLineId = 'line1' })
  const report = api.buildManagedFundsFinancialReport(project, state)
  const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch }
  const logo = await fs.readFile('public/cronos-report-mark.png')
  const downloads = []; let blob
  globalThis.window = { URL: { createObjectURL(value) { blob = value; return 'blob:test' }, revokeObjectURL() {} } }
  globalThis.document = { body: { append() {} }, createElement() { return { click() { downloads.push({ name: this.download, blob }) }, remove() {} } } }
  globalThis.fetch = async url => {
    assert.equal(url, '/cronos-report-mark.png')
    return new Response(logo, { headers: { 'Content-Type': 'image/png' } })
  }
  try {
    await api.exportManagedFundsCustomerFinancialWorkbook(report)
    const bytes = Buffer.from(await downloads[0].blob.arrayBuffer()), wb = XLSX.read(bytes, { type: 'buffer' })
    assert.deepEqual(wb.SheetNames, ['Funding Overview', 'Funded Purchases'])
    const overview = wb.Sheets['Funding Overview'], purchases = wb.Sheets['Funded Purchases']
    assert.equal(overview.B10.v, 11000)
    assert.equal(overview.F10.v, 1606.07)
    assert.equal(overview.J10.v, 9393.93)
    assert.equal(overview.F10.f, "'Funded Purchases'!E9")
    assert.equal(purchases.E9.f, 'ROUND(SUM(E7:E8),2)')
    assert.equal(overview.B19.v, 2)
    assert.equal(purchases.B7.v, state.actions[0].description.trim())
    assert.equal(purchases.B8.v, 'AccessNsite Deposit')
    assert.equal(purchases.B8.f, undefined)
    assert.deepEqual(XLSX.utils.sheet_to_json(purchases, { header: 1 })[5], ['Action', 'Purchase Description', 'PO Number', 'Status', 'Customer Amount'])
    const zip = await JSZip.loadAsync(bytes), parts = []
    assert.deepEqual(await zip.file('xl/media/cronos-report-mark.png').async('nodebuffer'), logo)
    for (const index of [1, 2]) {
      assert.match(await zip.file(`xl/worksheets/_rels/sheet${index}.xml.rels`).async('string'), new RegExp(`drawings/drawing${index}\\.xml`))
      assert.match(await zip.file(`xl/drawings/drawing${index}.xml`).async('string'), /name="Cronos Logo"/)
      assert.match(await zip.file(`xl/drawings/_rels/drawing${index}.xml.rels`).async('string'), /media\/cronos-report-mark\.png/)
    }
    assert.equal(overview.B3.v, 'CRONOS')
    assert.equal(purchases.A3.v, 'CRONOS')
    for (const file of Object.keys(zip.files).filter(p => /\.(xml|rels)$/.test(p))) parts.push(await zip.file(file).async('string'))
    assert.equal(/PRIVATE_|invoice|payment|billing|actualCost|unitCost|\bmarkup\b|\bmargin\b|internal-owner/i.test(parts.join('')), false, 'Workbook contains confidential or accounting content')
    const overviewXml = await zip.file('xl/worksheets/sheet1.xml').async('string')
    assert.match(overviewXml, /tabSelected="1"/)
    assert.match(overviewXml, /<dataBar showValue="0">/)
    assert.match(overviewXml, /fitToHeight="1"/)
    const registerXml = await zip.file('xl/worksheets/sheet2.xml').async('string')
    assert.match(registerXml, /ySplit="6"/)
    assert.match(registerXml, /autoFilter ref="A6:E8"/)
    const styles = await zip.file('xl/styles.xml').async('string')
    const cellFormats = [...styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)[1].matchAll(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)].map(m => m[0])
    for (const column of ['A', 'B', 'C', 'D', 'E']) {
      for (const [row, fill] of [[7, 0], [8, 9]]) {
        const styleId = Number(registerXml.match(new RegExp(`<c r="${column}${row}" s="(\\d+)"`))[1])
        assert.match(cellFormats[styleId], new RegExp(`fillId="${fill}"`), `Consistent shading for ${column}${row}`)
      }
    }
    assert.match(styles, /FF052E61/)
    assert.match(styles, /FFF2F5F7/)
    await api.exportManagedFundsDetailedEquipmentWorkbook(report)
    const equipment = XLSX.read(Buffer.from(await downloads[1].blob.arrayBuffer()), { type: 'buffer' })
    assert.deepEqual(equipment.SheetNames, ['Equipment List'])
    assert.equal(equipment.Sheets['Equipment List'].G7.v, 1200)
    const empty = { ...report, actions: [], lines: [], funding: { ...report.funding, committed: 0, available: report.funding.authorized } }
    await api.exportManagedFundsCustomerFinancialWorkbook(empty)
    const emptyWb = XLSX.read(Buffer.from(await downloads[2].blob.arrayBuffer()), { type: 'buffer' })
    assert.equal(emptyWb.Sheets['Funding Overview'].B19.v, 0)
    assert.equal(emptyWb.Sheets['Funded Purchases'].E7.v, 0)
    await assert.rejects(api.exportManagedFundsDetailedEquipmentWorkbook(empty), /No supported/)
    globalThis.fetch = async () => new Response('', { status: 503 })
    await assert.rejects(api.exportManagedFundsCustomerFinancialWorkbook(report), /Cronos logo could not be loaded/)
    assert.equal(downloads.length, 3, 'A missing logo does not produce an incomplete download')
  } finally {
    globalThis.window = original.window; globalThis.document = original.document; globalThis.fetch = original.fetch
    await fs.rm(output, { recursive: true, force: true })
  }
})
