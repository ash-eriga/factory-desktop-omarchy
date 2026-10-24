// Metadata only: never downloads payloads or changes an installed app.
import { versions } from './common.mjs';
const endpoint='https://api.factory.ai/api/desktop/latest-version';
try {
  const response=await fetch(endpoint,{redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error(`HTTP ${response.status}`);
  const {latestVersion}=await response.json();
  if(!/^\d+\.\d+\.\d+$/.test(latestVersion)) throw new Error('Unexpected upstream version');
  const compare=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let n=0;n<3;n++){if(x[n]!==y[n])return Math.sign(x[n]-y[n]);}return 0;};
  console.log(JSON.stringify({installedRecipe:versions.desktop,latestVersion,
    updateAvailable:compare(latestVersion,versions.desktop)>0,endpoint,
    action:compare(latestVersion,versions.desktop)>0?'Inspect the new upstream archive and update exact patch anchors before rebuilding.':'Recipe matches or exceeds the latest upstream.'},null,2));
} catch(error){console.error(`Upstream check failed: ${error.message}`);process.exitCode=1;}
