// The port's notifier is separate from the disabled proprietary updater.
// Main-process only: no new renderer IPC, downloads or installation rights.
export const updateNotificationMainChanges = [
  ['declare port update notifier',
    'function G1(){var c;',
    'var factoryPortUpdates;function G1(){var c;'],
  ['initialize port update notifier before building the application menu',
    'i.startupTracker.beginPhase("application_menu_create"),G1()',
    'i.startupTracker.beginPhase("application_menu_create"),process.platform==="linux"&&(factoryPortUpdates=require(Q.resolve(process.resourcesPath,"..","port","update-notifier.cjs")).createUpdateNotifier({electron:x,version:require(Q.resolve(process.resourcesPath,"..","port","release.json")).version,allowed:()=>i.getHostedServicesEnabled()&&i.getRuntimeAuthConfig().airgapEnabled!==!0&&!i.areDesktopUpdatesDisabledByCachedOrgSettings(),canAutoCheck:ul,rebuildMenu:G1})),G1()'],
  ['offer port release notifications instead of the vendor updater',
    'r=process.platform==="linux"||!t||i.areDesktopUpdatesDisabledByCachedOrgSettings()?[]:',
    'r=process.platform==="linux"?(factoryPortUpdates?.menuItems()??[]):!t||i.areDesktopUpdatesDisabledByCachedOrgSettings()?[]:'],
];

export function diagnoseUpdateNotificationHelpers(source) {
  return source.includes('factoryPortUpdates') ? ['factoryPortUpdates'] : [];
}

export function unpatchUpdateNotifications(source) {
  let result = source;
  for (const [name, before, after] of [...updateNotificationMainChanges].reverse()) {
    if (result.split(after).length !== 2) throw new Error(`Port update patch missing or duplicated: ${name}`);
    result = result.replace(after, before);
  }
  return result;
}
