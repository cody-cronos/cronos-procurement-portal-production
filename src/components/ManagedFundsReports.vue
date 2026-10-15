<script setup lang="ts">
import { computed, ref } from 'vue'
import { Download } from '@lucide/vue'
import type { Project } from '../types'
import type { FundsState } from '../domain/managedFunds.mjs'
import type { FundsWorkspace } from '../services/managedFundsApi'
import { loadFundsWorkspace } from '../services/managedFundsApi'
import { buildManagedFundsFinancialReport } from '../services/managedFundsFinancialReport.mjs'
import { exportManagedFundsCustomerFinancialWorkbook, exportManagedFundsDetailedEquipmentWorkbook } from '../services/customerFinancialExports'
import { currency } from '../services/calculations'

const props = defineProps<{ project: Project; state: FundsState; disabled?: boolean }>()
const emit = defineEmits<{ updated: [workspace: FundsWorkspace] }>()
const exporting = ref(false), error = ref(''), notice = ref('')
const preview = computed(() => {
  try { return { report: buildManagedFundsFinancialReport(props.project, props.state), error: '' } }
  catch (e) { return { report: undefined, error: e instanceof Error ? e.message : 'Review the saved funding records.' } }
})
const money = (cents: number) => currency(cents / 100)
async function download(equipment = false) {
  if (exporting.value || props.disabled) return
  exporting.value = true; error.value = ''; notice.value = ''
  try {
    const current = await loadFundsWorkspace(props.project.id)
    emit('updated', current)
    const report = buildManagedFundsFinancialReport(current.project, current.state)
    if (equipment) await exportManagedFundsDetailedEquipmentWorkbook(report)
    else await exportManagedFundsCustomerFinancialWorkbook(report)
    notice.value = `${equipment ? 'Detailed equipment list' : 'Customer financial report'} downloaded from the latest saved data.`
  } catch (e) { error.value = e instanceof Error ? e.message : 'The report could not be generated. Please retry.' }
  finally { exporting.value = false }
}
</script>

<template>
  <section class="customer-reports" aria-label="Customer financial report" :aria-busy="exporting">
    <h2>Customer Financial Report</h2>
    <p>Funding Overview and Funded Purchases, with customer amounts and procurement status.</p>
    <p v-if="error || preview.error" class="report-error" role="alert">{{ error || preview.error }}</p>
    <p v-if="notice" class="report-notice" role="status">{{ notice }}</p>
    <template v-if="preview.report">
      <div class="report-metrics">
        <div><span>Total Funding</span><strong>{{ money(preview.report.funding.authorized) }}</strong></div>
        <div><span>Funds Committed</span><strong>{{ money(preview.report.funding.committed) }}</strong></div>
        <div class="available"><span>Funds Available</span><strong>{{ money(preview.report.funding.available) }}</strong></div>
      </div>
      <p>Funded Purchase Actions: {{ preview.report.actions.length }}</p>
      <div class="report-buttons">
        <button class="primary-action" :disabled="exporting || disabled" @click="download()"><Download :size="16"/> Financial Excel</button>
        <button class="secondary-action" :disabled="exporting || disabled || !preview.report.lines.length" @click="download(true)"><Download :size="16"/> Export Detailed Equipment List</button>
      </div>
      <p v-if="!preview.report.lines.length" class="report-help">No supported customer-approved equipment details are available for this project.</p>
      <div class="report-table"><table><caption>Funded Purchases</caption><thead><tr><th>Action</th><th>Purchase Description</th><th>PO Number</th><th>Status</th><th class="amount">Customer Amount</th></tr></thead><tbody><tr v-for="a in preview.report.actions" :key="a.actionNumber"><td>{{ a.actionNumber }}</td><td>{{ a.description }}</td><td class="po">{{ a.purchaseOrderNumbers || '—' }}</td><td>{{ a.status === 'Received' ? 'Processing' : a.status }}</td><td class="amount">{{ money(a.committed) }}</td></tr><tr v-if="!preview.report.actions.length"><td colspan="5">No funded purchase actions.</td></tr></tbody><tfoot><tr><th colspan="4">Total Funds Committed</th><td class="amount">{{ money(preview.report.funding.committed) }}</td></tr></tfoot></table></div>
    </template>
    <p v-if="exporting" role="status">Refreshing saved data and preparing your report…</p>
  </section>
</template>

<style scoped>
.customer-reports{background:#fff;border:1px solid #dce4ed;border-radius:14px;padding:24px;color:#142a46}.customer-reports h2{margin:0 0 8px}.customer-reports p{color:#5e7085;line-height:1.5}.report-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:24px 0}.report-metrics>div{padding:20px;background:#f4f7fb;border-radius:8px}.report-metrics span{display:block;font-size:13px}.report-metrics strong{display:block;margin-top:8px;font-size:26px}.report-metrics .available{background:#edf6f0;color:#24634a}.report-buttons{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}.report-table{overflow:auto}.report-table table{border-collapse:collapse;width:100%;min-width:750px;font-size:14px}.report-table caption{text-align:left;font-size:18px;font-weight:700;margin:18px 0 12px}.report-table td,.report-table th{padding:14px 12px;text-align:left;border-bottom:1px solid #dce4ed;vertical-align:top}.report-table th{background:#edf2f8}.report-table .amount{text-align:right;white-space:nowrap}.report-table .po{white-space:pre-line}.report-table tfoot{font-weight:700}.report-error{background:#fff0ef;padding:14px;border-radius:8px;color:#a12022!important}.report-notice{color:#186443!important}.report-help{font-size:13px}button:disabled{opacity:.55;cursor:not-allowed}@media(max-width:750px){.report-metrics{grid-template-columns:1fr}.customer-reports{padding:16px}}
</style>
