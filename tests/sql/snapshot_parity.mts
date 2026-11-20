// Compares agreement snapshot v1 bytes and agreement_hash for two contract rows.
import { readFileSync } from 'node:fs'
import { buildAgreementSnapshot, deriveAgreementHash, stableStringify } from '../../supabase/functions/_shared/eventCanonical.ts'
const { rpc, legacy } = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const a = stableStringify(buildAgreementSnapshot(rpc)), b = stableStringify(buildAgreementSnapshot(legacy))
const [ha, hb] = [await deriveAgreementHash(rpc), await deriveAgreementHash(legacy)]
if (a !== b || ha !== hb) { console.error(`FAIL snapshot parity\n rpc:    ${a} ${ha}\n legacy: ${b} ${hb}`); process.exit(1) }
console.log(`PASS snapshot v1 bytes and agreement_hash identical (${ha.slice(0, 16)}…, ${a.length} bytes)`)
