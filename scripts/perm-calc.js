'use strict';

const { permissionInteger, PRESETS } = require('../discord-bridge');

function main(argv) {
  const names = argv.slice(2);
  if (names.length === 0) {
    console.log(`68608 base (view, send, history) = ${PRESETS.base}`);
    console.log(`68672 base+reactions = ${PRESETS.reactions}`);
    console.log(`85056 embeds+reactions = ${PRESETS.embedsAndReactions}`);
    console.log(`274877992000 threads = ${PRESETS.withThreads}`);
    return PRESETS;
  }
  if (names.some((name) => String(name).toUpperCase() === 'ADMINISTRATOR')) {
    console.error('ADMINISTRATOR is never allowed');
    process.exitCode = 2;
    return null;
  }
  try {
    const value = permissionInteger(names);
    console.log(String(value));
    return value;
  } catch (err) {
    console.error('permission calculation failed');
    process.exitCode = 2;
    return null;
  }
}

if (require.main === module) main(process.argv);

module.exports = { main };
