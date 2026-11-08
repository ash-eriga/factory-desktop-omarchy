// The port's notifier is separate from the disabled proprietary updater.
// Main-process only: no new renderer IPC, downloads or installation rights.
export const updateNotificationMainChanges = [
  ['declare port update notifier',
    'function Yd(){var d;',
    'var factoryPortUpdates;function Yd(){var d;'],
  ['initialize port update notifier before building the application menu',
    's.startupTracker.beginPhase("application_menu_create"),Yd(),s.onDesktopUpdatePolicyChange(Yd)',
    's.startupTracker.beginPhase("application_menu_create"),process.platform==="linux"&&(factoryPortUpdates=require(De.resolve(process.resourcesPath,"..","port","update-notifier.cjs")).createUpdateNotifier({electron:I,version:require(De.resolve(process.resourcesPath,"..","port","release.json")).version,allowed:()=>s.getHostedServicesEnabled()&&s.getRuntimeAuthConfig().airgapEnabled!==!0&&!s.areDesktopUpdatesDisabledByCachedOrgSettings(),canAutoCheck:Ga,rebuildMenu:Yd})),Yd(),s.onDesktopUpdatePolicyChange(Yd)'],
  ['offer port release notifications instead of the vendor updater',
    'o=process.platform==="linux"||!n||s.areDesktopUpdatesDisabledByCachedOrgSettings()?[]:',
    'o=process.platform==="linux"?(factoryPortUpdates?.menuItems()??[]):!n||s.areDesktopUpdatesDisabledByCachedOrgSettings()?[]:'],
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
