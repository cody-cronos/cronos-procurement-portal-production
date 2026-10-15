// Customer-only workbook writer, ported from the approved FY2027 report.
// Kept separate so existing internal, quote and tracking exports remain unchanged.
import { managedFundsFinancialSheets, managedFundsEquipmentSheet } from './managedFundsFinancialWorkbook'
import { sheetViewsXml, WORKBOOK_VIEWS_XML, corePropertiesXml } from './xlsxStructure.mjs'
import type { FreezePane } from './xlsxStructure.mjs'
import { documentValue } from './documentGeneration'

export async function exportManagedFundsCustomerFinancialWorkbook(report: import('./managedFundsFinancialReport.mjs').ManagedFundsFinancialReport) {
  await downloadWorkbook(managedFundsFinancialSheets(report), 'Cronos-' + sanitizeFileName(report.projectNumber) + '-Customer-Financial-Report.xlsx')
}

export async function exportManagedFundsDetailedEquipmentWorkbook(report: import('./managedFundsFinancialReport.mjs').ManagedFundsFinancialReport, actionNumber?: string) {
  await downloadWorkbook([managedFundsEquipmentSheet(report, actionNumber)], 'Cronos-' + sanitizeFileName(report.projectNumber)
    + (actionNumber ? '-' + sanitizeFileName(actionNumber) : '') + '-Detailed-Equipment-List.xlsx')
}

export type WorkbookCell =
  | string
  | number
  | {
      value?: string | number
      formula?: string
      style?: number
    }
export type WorkbookSheet = {
  name: string
  rows: WorkbookCell[][]
  columnWidths?: number[]
  merges?: string[]
  freezePane?: FreezePane
  autoFilter?: string
  printTitleRows?: string
  rowHeights?: Record<number, number>
  reportTitle?: string
  showGridLines?: boolean
  landscape?: boolean
  image?: 'cronosLogo'
  logo?: { column: number; row: number; columns: number; width: number; height: number; offsetY?: number }
  printArea?: string
  dataBar?: { range: string; color: string; showValue?: boolean }
  fitToHeight?: number
  zoomScale?: number
  selected?: boolean
}

async function downloadWorkbook(sheets: WorkbookSheet[], fileName: string) {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  const logoBytes = sheets.some(sheet => sheet.image === 'cronosLogo') ? await fetchCronosLogo() : null

  zip.file('[Content_Types].xml', contentTypesXml(sheets))
  zip.file('_rels/.rels', rootRelsXml())
  zip.file('docProps/app.xml', appXml())
  zip.file('docProps/core.xml', coreXml())
  zip.file('xl/workbook.xml', workbookXml(sheets))
  zip.file('xl/_rels/workbook.xml.rels', workbookRelsXml(sheets))
  zip.file('xl/styles.xml', stylesXml())
  sheets.forEach((sheet, index) => {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet, Boolean(logoBytes)))
    if (sheet.image === 'cronosLogo' && logoBytes) {
      zip.file(`xl/worksheets/_rels/sheet${index + 1}.xml.rels`, sheetDrawingRelsXml(index + 1))
      zip.file(`xl/drawings/drawing${index + 1}.xml`, drawingXml(sheet))
      zip.file(`xl/drawings/_rels/drawing${index + 1}.xml.rels`, drawingRelsXml())
    }
  })

  if (logoBytes) zip.file('xl/media/cronos-report-mark.png', logoBytes)

  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

function worksheetXml(sheet: WorkbookSheet, hasLogo: boolean) {
  const columnXml = sheet.columnWidths?.length
    ? `<cols>${sheet.columnWidths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`
    : ''
  const frozenViewsXml = sheetViewsXml(sheet.freezePane)
  const baseViewsXml = sheet.showGridLines === false
    ? frozenViewsXml.replace('<sheetView workbookViewId="0">', '<sheetView workbookViewId="0" showGridLines="0">') || '<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>'
    : frozenViewsXml
  const viewsXml = baseViewsXml.replace('<sheetView workbookViewId="0"', `<sheetView workbookViewId="0"${sheet.zoomScale ? ` zoomScale="${sheet.zoomScale}" zoomScaleNormal="${sheet.zoomScale}"` : ''}${sheet.selected ? ' tabSelected="1"' : ''}`)
  const mergeXml = sheet.merges?.length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map(ref => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
    : ''
  const autoFilterXml = sheet.autoFilter ? `<autoFilter ref="${escapeXml(sheet.autoFilter)}"/>` : ''
  const dataBarXml = sheet.dataBar ? `<conditionalFormatting sqref="${escapeXml(sheet.dataBar.range)}"><cfRule type="dataBar" priority="1"><dataBar showValue="${sheet.dataBar.showValue === false ? 0 : 1}"><cfvo type="num" val="0"/><cfvo type="num" val="1"/><color rgb="FF${escapeXml(sheet.dataBar.color)}"/></dataBar></cfRule></conditionalFormatting>` : ''
  const drawingXml = sheet.image === 'cronosLogo' && hasLogo ? '<drawing r:id="rId1"/>' : ''
  const pageSetupXml = sheet.landscape
    ? `<printOptions horizontalCentered="1"/><pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.25" footer="0.25"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="${sheet.fitToHeight ?? 0}"/><headerFooter><oddHeader>&amp;C${escapeXml(sheet.reportTitle || 'Material Tracking Report')}</oddHeader><oddFooter>&amp;LAtlas ${escapeXml(sheet.reportTitle || 'Material Tracking')}&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter>`
    : ''
  const body = sheet.rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, columnIndex) => cellXml(cell, `${columnName(columnIndex + 1)}${rowIndex + 1}`))
        .join('')
      const height = sheet.rowHeights?.[rowIndex + 1] ?? worksheetRowHeight(row)
      return `<row r="${rowIndex + 1}"${height ? ` ht="${height}" customHeight="1"` : ''}>${cells}</row>`
    })
    .join('')

  return xmlHeader(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${sheet.printArea ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : ''}${viewsXml}${columnXml}<sheetData>${body}</sheetData>${autoFilterXml}${mergeXml}${dataBarXml}${pageSetupXml}${drawingXml}</worksheet>`)
}

function worksheetRowHeight(row: WorkbookCell[]) {
  const wrappedLengths = row
    .map(cell => (typeof cell === 'object' && cell !== null && (cell.style === 7 || cell.style === 22) ? String(cell.value ?? '').length : 0))
    .filter(Boolean)
  if (!wrappedLengths.length) return 0
  const longest = Math.max(...wrappedLengths)
  if (longest < 55) return 24
  if (longest < 120) return 42
  return 60
}

function cellXml(cell: WorkbookCell, reference: string) {
  const normalized = typeof cell === 'object' && cell !== null ? cell : { value: cell }
  const style = normalized.style ? ` s="${normalized.style}"` : ''
  if (normalized.formula) {
    const stringResult = typeof normalized.value === 'string'
    const cached = typeof normalized.value === 'number' ? `<v>${Number.isFinite(normalized.value) ? normalized.value : 0}</v>`
      : stringResult ? `<v>${escapeXml(String(normalized.value))}</v>` : ''
    return `<c r="${reference}"${style}${stringResult ? ' t="str"' : ''}><f>${escapeXml(normalized.formula)}</f>${cached}</c>`
  }
  if (typeof normalized.value === 'number') return `<c r="${reference}"${style}><v>${Number.isFinite(normalized.value) ? normalized.value : 0}</v></c>`
  const isLayoutBlank = normalized.value === ''
  const value = isLayoutBlank ? '' : documentValue(normalized.value)
  return `<c r="${reference}"${style} t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`
}

function workbookXml(sheets: WorkbookSheet[]) {
  const sheetEntries = sheets
    .map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('')
  const definedNames = sheets
    .map((sheet, index) =>
      (sheet.printTitleRows ? `<definedName name="_xlnm.Print_Titles" localSheetId="${index}">${escapeXml(quoteSheetName(sheet.name))}!$${sheet.printTitleRows.replace(':', ':$')}</definedName>` : '')
      + (sheet.printArea ? `<definedName name="_xlnm.Print_Area" localSheetId="${index}">${escapeXml(quoteSheetName(sheet.name))}!${sheet.printArea.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>` : ''),
    )
    .join('')

  return xmlHeader(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${WORKBOOK_VIEWS_XML}<sheets>${sheetEntries}</sheets>${definedNames ? `<definedNames>${definedNames}</definedNames>` : ''}</workbook>`)
}

function workbookRelsXml(sheets: WorkbookSheet[]) {
  const sheetRels = sheets
    .map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join('')

  return xmlHeader(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)
}

function contentTypesXml(sheets: WorkbookSheet[]) {
  const sheetTypes = sheets
    .map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('')
  const pngType = sheets.some(sheet => sheet.image) ? '<Default Extension="png" ContentType="image/png"/>' : ''
  const drawingTypes = sheets.map((sheet, index) => sheet.image ? `<Override PartName="/xl/drawings/drawing${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` : '').join('')
  return xmlHeader(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${pngType}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${drawingTypes}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${sheetTypes}</Types>`)
}

function rootRelsXml() {
  return xmlHeader('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>')
}

function stylesXml() {
  return xmlHeader(`
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="8"><numFmt numFmtId="164" formatCode="_(&quot;$&quot;* #,##0.00_);_(&quot;$&quot;* (#,##0.00);_(&quot;$&quot;* &quot;-&quot;??_);_(@_)"/><numFmt numFmtId="165" formatCode="+&quot;$&quot;#,##0.00;-&quot;$&quot;#,##0.00;&quot;$&quot;0.00"/><numFmt numFmtId="166" formatCode="&quot;$&quot;#,##0.00;-&quot;$&quot;#,##0.00;&quot;$&quot;0.00"/><numFmt numFmtId="167" formatCode=";;;"/><numFmt numFmtId="168" formatCode="&quot;Committed: &quot;0.0%"/><numFmt numFmtId="169" formatCode="&quot;Available: &quot;0.0%"/><numFmt numFmtId="170" formatCode="&quot;Funded Purchase Actions: &quot;#,##0"/><numFmt numFmtId="171" formatCode="&quot;Report Date: &quot;mmm d, yyyy"/></numFmts>
  <fonts count="16">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Arial"/></font>
    <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>
    <font><b/><sz val="12"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF052E61"/><name val="Arial"/></font>
    <font><b/><sz val="18"/><color rgb="FF052E61"/><name val="Arial"/></font>
    <font><sz val="11"/><color rgb="FF566779"/><name val="Arial"/></font>
    <font><b/><sz val="20"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>
    <font><b/><sz val="22"/><color rgb="FF052E61"/><name val="Calibri"/></font>
    <font><b/><sz val="20"/><color rgb="FF052E61"/><name val="Calibri"/></font>
    <font><b/><sz val="20"/><color rgb="FF052E61"/><name val="Calibri"/></font>
    <font><sz val="11"/><color rgb="FF536072"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF052E61"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
    <font><b/><sz val="12"/><color rgb="FF052E61"/><name val="Calibri"/></font>
    <font><b/><sz val="20"/><color rgb="FF000000"/><name val="Arial"/></font>
  </fonts>
  <fills count="10">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF052E61"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8FBFF"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDFF5E7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDDEBFF"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF1C7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFE3C2"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFD6D6"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF2F5F7"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border/>
    <border><left style="thin"><color rgb="FFD8DEE8"/></left><right style="thin"><color rgb="FFD8DEE8"/></right><top style="thin"><color rgb="FFD8DEE8"/></top><bottom style="thin"><color rgb="FFD8DEE8"/></bottom></border>
    <border><left style="medium"><color rgb="FF052E61"/></left><right style="medium"><color rgb="FF052E61"/></right><top style="medium"><color rgb="FF052E61"/></top><bottom style="medium"><color rgb="FF052E61"/></bottom></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="72">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1" applyBorder="1"><alignment wrapText="1"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="2" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>
    <xf numFmtId="164" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="4" fillId="3" borderId="2" xfId="0" applyFill="1" applyBorder="1"/>
    <xf numFmtId="164" fontId="4" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="5" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="2" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="4" fillId="3" borderId="2" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="7" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="8" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="9" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>
    <xf numFmtId="166" fontId="5" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="166" fontId="5" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1" indent="1"/></xf>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center" indent="1"/></xf>
    <xf numFmtId="0" fontId="7" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="4" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="166" fontId="5" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="9" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="166" fontId="0" fillId="9" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="9" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="166" fontId="4" fillId="9" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="9" fontId="4" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="12" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="8" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="11" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="12" fillId="9" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="166" fontId="9" fillId="9" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="13" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="166" fontId="7" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="14" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="167" fontId="0" fillId="9" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="168" fontId="11" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="169" fontId="11" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="170" fontId="14" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="13" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="14" fillId="9" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="166" fontId="14" fillId="9" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="12" fillId="9" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="12" fillId="5" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="12" fillId="4" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="171" fontId="11" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="15" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="8" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="12" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="12" fillId="9" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="13" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="166" fontId="13" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
  </cellXfs>
</styleSheet>`.replace(/\n\s*/g, ''))
}

async function fetchCronosLogo() {
  const response = await fetch('/cronos-report-mark.png')
  if (!response.ok) throw new Error('The Cronos logo could not be loaded. Refresh and retry the report.')
  return await response.arrayBuffer()
}
function sheetDrawingRelsXml(index: number) {
  return xmlHeader(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${index}.xml"/></Relationships>`)
}
function drawingRelsXml() {
  return xmlHeader('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/cronos-report-mark.png"/></Relationships>')
}
function drawingXml(sheet: WorkbookSheet) {
  const logo = sheet.logo!
  const y = (logo.offsetY ?? 3) * 9525
  return xmlHeader(`<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${logo.column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${logo.row}</xdr:row><xdr:rowOff>${y}</xdr:rowOff></xdr:from><xdr:to><xdr:col>${logo.column + logo.columns}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${logo.row}</xdr:row><xdr:rowOff>${y + logo.height * 9525}</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Cronos Logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${logo.width * 9525}" cy="${logo.height * 9525}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`)
}

function appXml() {
  return xmlHeader('<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Cronos Procurement</Application></Properties>')
}

function coreXml() {
  return xmlHeader(corePropertiesXml('Cronos Procurement'))
}

function xmlHeader(body: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`
}

function sanitizeFileName(value: string) {
  return value.replace(/[^a-z0-9-_]+/gi, '-')
}

function quoteSheetName(value: string) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function columnName(index: number): string {
  let column = ''
  let current = index
  while (current > 0) {
    const remainder = (current - 1) % 26
    column = String.fromCharCode(65 + remainder) + column
    current = Math.floor((current - 1) / 26)
  }
  return column
}

function escapeXml(value: string) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
