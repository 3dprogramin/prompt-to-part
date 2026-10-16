// Model scripts are untrusted code: Claude writes them from user prompts and photos, and designs
// can be shared. shared/runtime.ts evaluates each one in an SES Compartment that holds only
// Manifold, CrossSection, H, quality and console: no process, require, import(), fetch, timers,
// network or app API. lockdown() freezes the shared built-ins and disarms Function constructors,
// so a script can't reach the host through `x.constructor.constructor` or by changing prototypes.
//
// Import this module FIRST in every geometry worker, before manifold-3d or the runtime.
import 'ses';

lockdown({
  errorTaming: 'unsafe', // keep stack traces: error line numbers in model.js come from them
  stackFiltering: 'verbose',
  overrideTaming: 'severe', // let libraries assign over frozen prototype properties
  consoleTaming: 'unsafe',
  localeTaming: 'unsafe',
});
