import assert from 'node:assert/strict';
import dbus from 'dbus-next';
import { TrayService, trayName } from '../../packages/adapters/src/tray.ts';
const watcherName='org.kde.StatusNotifierWatcher';
let registered=0;
class Watcher extends dbus.interface.Interface {
  constructor(){ super(watcherName); }
  RegisterStatusNotifierItem(name){ assert.equal(name,trayName); registered++; }
}
Watcher.configureMembers({methods:{RegisterStatusNotifierItem:{inSignature:'s',outSignature:''}}});
const host=dbus.sessionBus(),client=dbus.sessionBus();const actions=[];
const tray=new TrayService(settings=>actions.push(settings));
const wait=async predicate=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw new Error('tray timeout');await new Promise(r=>setTimeout(r,20));}};
try {
  tray.start();
  await host.requestName(watcherName,4);host.export('/StatusNotifierWatcher',new Watcher());
  await wait(()=>registered===1);
  const proxy=(await client.getProxyObject(trayName,'/StatusNotifierItem')).getInterface('org.kde.StatusNotifierItem');
  await proxy.Activate(0,0);await proxy.ContextMenu(0,0);assert.deepEqual(actions,[false,true]);
  await host.releaseName(watcherName);await wait(()=>tray.status.status==='unconfigured');
  await host.requestName(watcherName,4);await wait(()=>registered===2);assert.equal(tray.status.status,'ready');
  console.log('TRAY_PASSED');
} finally { tray.close();client.disconnect();host.disconnect(); }
