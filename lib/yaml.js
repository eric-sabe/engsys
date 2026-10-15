'use strict';

// yaml.js — re-export shim. The canonical implementation lives at core/lib/yaml.js (engsys#140,
// C1): plugin mode ships ONLY core/'s contents, so any module a hook needs at runtime must live
// under core/ — a sibling script that `require('../../lib/yaml.js')` (outside core/) crashes with
// ERR_MODULE_NOT_FOUND in every plugin-mode install, before the hook's own try/catch can run.
// This file keeps the copy-mode installer (lib/util.js, lib/commands.js) working unchanged by
// re-exporting the one real implementation instead of carrying a second copy that could drift.
module.exports = require('../core/lib/yaml.js');
