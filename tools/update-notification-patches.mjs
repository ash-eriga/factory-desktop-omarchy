// The port's notifier is separate from the disabled proprietary updater.
// Main-process only: no new renderer IPC, downloads or installation rights.
export const updateNotificationMainChanges = [
  ['declare port update notifier',
    'function id(){var u;',
    'var factoryPortUpdates;function id(){var u;'],
  ['initialize port update notifier before building the application menu',
    's.startupTracker.beginPhase("application_menu_create"),id(),s.onDesktopUpdatePolicyChange(id)',
    's.startupTracker.beginPhase("application_menu_create"),process.platform==="linux"&&(factoryPortUpdates=require(J.resolve(process.resourcesPath,"..","port","update-notifier.cjs")).createUpdateNotifier({electron:E,version:require(J.resolve(process.resourcesPath,"..","port","release.json")).version,allowed:()=>s.getHostedServicesEnabled()&&s.getRuntimeAuthConfig().airgapEnabled!==!0&&!s.areDesktopUpdatesDisabledByCachedOrgSettings(),canAutoCheck:jd,rebuildMenu:id})),id(),s.onDesktopUpdatePolicyChange(id)'],
  ['offer port release notifications instead of the vendor updater',
    'r=process.platform==="linux"||!n||s.areDesktopUpdatesDisabledByCachedOrgSettings()?[]:',
    'r=process.platform==="linux"?(factoryPortUpdates?.menuItems()??[]):!n||s.areDesktopUpdatesDisabledByCachedOrgSettings()?[]:'],
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
