'use strict';
const {app,safeStorage}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {Store}=require('../overlay/storage');
const resultsFile=path.resolve(__dirname,'..','.test-output','desktop-test-results.json');
const report=JSON.parse(fs.readFileSync(resultsFile,'utf8'));
const profile=path.resolve(report.profile);
assert.equal(path.dirname(profile),path.resolve(os.tmpdir()));
assert.ok(path.basename(profile).startsWith('opencluely-test-'));
app.setName('OpenCluely Overlay');
app.setPath('userData',profile);
if (process.platform === 'win32') app.setAppUserModelId('com.opencluely.overlay');
app.whenReady().then(()=>{
  const result={name:'verified replacement key restores in a new Electron process',passed:false};
  try {
    const store=new Store(profile,safeStorage);
    assert.deepEqual(store.read('credentials.enc',{},true),{gemini:'replacement-gemini-test-key',openai:'test-openai-not-a-real-api-key'});
    assert.equal(store.read('preferences.json',{}).hideFromCapture,true);
    assert.equal(store.read('conversation.enc',[],true)[0].text,'Current chat after restart');
    const chats=store.read('chats.enc',null,true);
    assert.equal(chats.current[0].text,'Current chat after restart');
    assert.equal(chats.archive[0].history[0].text,'Archived chat after restart');
    assert.equal(store.read('preferences.json',{}).models.openai,'gpt-6.1-sol');
    assert.equal(store.read('preferences.json',{}).reasoningEfforts.openai['gpt-6.1-sol'],'high');
    assert.equal(store.read('preferences.json',{}).reasoningEfforts.openai['gpt-6-luna'],'medium');
    assert.ok(store.read('model-catalog.json',{}).openai.models.some(model=>model.id === 'gpt-6.1-sol'));
    result.passed=true; console.log(`PASS ${result.name}`);
  } catch { result.error='Saved test profile did not restore after process restart'; console.error(`FAIL ${result.name}`); }
  report.results.push(result); fs.writeFileSync(resultsFile,JSON.stringify(report,null,2)); app.exit(result.passed?0:1);
});
