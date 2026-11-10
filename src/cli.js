#!/usr/bin/env node
/**
 * Thin launcher. node:sqlite is still flagged experimental and prints a warning
 * on load; this CLI suppresses that one warning and leaves all others intact.
 * It has to happen before node:sqlite is loaded, and ESM `import` declarations
 * are hoisted above top-level code -- so the real entry point is imported
 * dynamically, after the handler is installed.
 */
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  console.error(`${w.name}: ${w.message}`);
});

await import('./main.js');
