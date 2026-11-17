// The build the browser is running, stamped on every version it creates. `import.meta.env` does not
// exist outside Vite (node --test), hence the `?.`.
import { cleanAppBuild, type AppBuild } from '../../shared/appBuild';

export function appBuild(): AppBuild {
  const env = import.meta.env;
  return cleanAppBuild({ version: env?.VITE_APP_VERSION, commit: env?.VITE_APP_COMMIT }) ?? { version: 'unknown' };
}
