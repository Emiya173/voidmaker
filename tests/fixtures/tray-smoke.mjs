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
const tray=new TrayService(action=>actions.push(action));
const wait=async predicate=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw new Error('tray timeout');await new Promise(r=>setTimeout(r,20));}};
try {
  tray.start();
  await host.requestName(watcherName,4);host.export('/StatusNotifierWatcher',new Watcher());
  await wait(()=>registered===1);
  const proxy=(await client.getProxyObject(trayName,'/StatusNotifierItem')).getInterface('org.kde.StatusNotifierItem');
  await proxy.Activate(0,0);await proxy.ContextMenu(0,0);assert.deepEqual(actions,[{type:'toggle'},{type:'open',page:'settings'}]);
  const properties=(await client.getProxyObject(trayName,'/StatusNotifierItem')).getInterface('org.freedesktop.DBus.Properties');
  const menuPath=(await properties.Get('org.kde.StatusNotifierItem','Menu')).value;
  assert.notEqual(menuPath,'/');
  const menu=(await client.getProxyObject(trayName,menuPath)).getInterface('com.canonical.dbusmenu');
  const [revision,layout]=await menu.GetLayout(0,-1,[]);
  assert.equal(revision,1);assert.equal(layout[0],0);
  assert.deepEqual(layout[2].filter(child=>child.value[1].label).map(child=>child.value[1].label.value),['显示/隐藏 VoidMaker','对话','后台任务','会话与记忆','桌面感知','停止当前对话（含语音）','设置','服务诊断']);
  assert.equal((await menu.GetLayout(0,0,[]))[1][2].length,0);
  assert.deepEqual(Object.keys((await menu.GetLayout(2,-1,['label']))[1][1]),['label']);
  assert.equal((await menu.GetProperty(2,'label')).value,'设置');
  assert.deepEqual((await menu.GetGroupProperties([1,2,999],['label'])).map(entry=>entry[0]),[1,2]);
  assert.equal(await menu.AboutToShow(0),false);
  assert.deepEqual(await menu.AboutToShowGroup([0,999]),[[],[999]]);
  await menu.Event(2,'hovered',new dbus.Variant('i',0),0);
  await menu.Event(0,'opened',new dbus.Variant('i',0),0);
  await menu.Event(10,'clicked',new dbus.Variant('i',0),0);
  assert.equal(layout[2].filter(child=>child.value[1].type?.value==='separator').length,3);
  assert.deepEqual(actions,[{type:'toggle'},{type:'open',page:'settings'}]);
  await assert.rejects(menu.Event(999,'clicked',new dbus.Variant('i',0),0));
  await menu.Event(2,'clicked',new dbus.Variant('i',0),0);
  assert.deepEqual(await menu.EventGroup([[1,'clicked',new dbus.Variant('i',0),0],[999,'clicked',new dbus.Variant('i',0),0]]),[999]);
  assert.deepEqual(actions,[{type:'toggle'},{type:'open',page:'settings'},{type:'open',page:'settings'},{type:'toggle'}]);
  await host.releaseName(watcherName);await wait(()=>tray.status.status==='unconfigured');
  await host.requestName(watcherName,4);await wait(()=>registered===2);assert.equal(tray.status.status,'ready');
  await menu.Event(2,'clicked',new dbus.Variant('i',0),0);
  assert.deepEqual(actions,[{type:'toggle'},{type:'open',page:'settings'},{type:'open',page:'settings'},{type:'toggle'},{type:'open',page:'settings'}]);
  for (const [id,action] of [[3,{type:'open',page:'chat'}],[4,{type:'open',page:'work'}],[5,{type:'open',page:'history'}],[6,{type:'open',page:'desktop'}],[7,{type:'stop'}],[8,{type:'open',page:'diagnostics'}]]) {
    await menu.Event(id,'clicked',new dbus.Variant('i',0),0);
    assert.deepEqual(actions.at(-1),action);
  }
  console.log('TRAY_PASSED');
} finally { tray.close();client.disconnect();host.disconnect(); }
