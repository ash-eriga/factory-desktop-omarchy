// The port's notifier is separate from the disabled proprietary updater.
// Main-process only: no new renderer IPC, downloads or installation rights.
export const updateNotificationMainChanges = [
  ['declare port update notifier',
    'function Au(){var d;',
    'var factoryPortUpdates;function Au(){var d;'],
  ['initialize port update notifier before building the application menu',
    'r.startupTracker.beginPhase("application_menu_create"),Au(),r.onDesktopUpdatePolicyChange(Au)',
    'r.startupTracker.beginPhase("application_menu_create"),process.platform==="linux"&&(factoryPortUpdates=require(J.resolve(process.resourcesPath,"..","port","update-notifier.cjs")).createUpdateNotifier({electron:A,version:require(J.resolve(process.resourcesPath,"..","port","release.json")).version,allowed:()=>r.getHostedServicesEnabled()&&r.getRuntimeAuthConfig().airgapEnabled!==!0&&!r.areDesktopUpdatesDisabledByCachedOrgSettings(),canAutoCheck:vc,rebuildMenu:Au})),Au(),r.onDesktopUpdatePolicyChange(Au)'],
  ['offer port release notifications instead of the vendor updater',
    's=process.platform==="linux"||!n||r.areDesktopUpdatesDisabledByCachedOrgSettings()?[]:',
    's=process.platform==="linux"?(factoryPortUpdates?.menuItems()??[]):!n||r.areDesktopUpdatesDisabledByCachedOrgSettings()?[]:'],
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
