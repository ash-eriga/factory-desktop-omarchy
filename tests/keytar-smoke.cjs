// Run with ELECTRON_RUN_AS_NODE=1 <bundle>/factory-desktop this-file <bundle>.
// Uses one random, disposable keyring entry; never reads account credentials.
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
const bundle=path.resolve(process.argv[2]);
const keytar=require(path.join(bundle,'resources/app.asar/node_modules/keytar'));
const service=`factory-desktop-arch-validation-${randomUUID()}`;
(async()=>{
  try{
    await keytar.setPassword(service,'temporary-test','temporary-validation-value');
    assert.equal(await keytar.getPassword(service,'temporary-test'),'temporary-validation-value');
  }finally{
    await keytar.deletePassword(service,'temporary-test');
  }
  assert.equal(await keytar.getPassword(service,'temporary-test'),null);
  console.log('Linux keytar: temporary write/read/delete passed; no account credentials accessed.');
})().catch(error=>{console.error(error.message);process.exitCode=1});
