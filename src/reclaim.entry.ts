// Userscript / extension entry for app.reclaim.ai. Kept apart from reclaim.ts so that importing its
// pure helpers (tests) never starts the page script.
import { main } from './reclaim.ts';

if (typeof document !== 'undefined' && typeof location !== 'undefined' && location.hostname === 'app.reclaim.ai') main();
