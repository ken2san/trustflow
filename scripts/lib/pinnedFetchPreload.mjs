// `node --import <this file> <script>`: the pinned fetch of ./pinnedFetch.mjs,
// installed before the script's first module runs, and a refusal to start if
// the child was handed any project URL but E2E.
import { installPinnedFetch, E2E_ORIGIN } from './pinnedFetch.mjs'

const url = (process.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '')
if (url !== E2E_ORIGIN) throw new Error('pinned child: VITE_SUPABASE_URL is not the E2E project')
installPinnedFetch()
