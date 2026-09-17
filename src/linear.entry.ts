// Userscript / extension entry for linear.app. Kept apart from linear.ts so that importing its pure
// helpers (bookmarklet, tests) never starts the page script.
import { main } from './linear.ts';

if (typeof document !== 'undefined' && typeof location !== 'undefined' && /(^|\.)linear\.app$/.test(location.hostname)) main();
