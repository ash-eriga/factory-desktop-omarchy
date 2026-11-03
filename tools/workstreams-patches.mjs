// Workstreams are the sidebar's multi-agent workspace section, which
// upstream ships behind the `missions_v2` Statsig gate and marks beta. With
// no account signed in, the gate falls back to its bundled default, and that
// default keeps the feature off (or hides it outright behind `hide_missions`
// once an organization disables it). The port turns the default on, so the
// sidebar shows Workstreams from the first launch instead of waiting for a
// server-side experiment decision.
//
// The flag's own semantics stay upstream's: `hide_missions` (organization
// hide) keeps winning over this default — an organization that disables
// Workstreams still does not see them. Only the disabled-by-default state
// changes.
//
// Exact anchor from the inspected, checksum-pinned Desktop 1.2.0 renderer.
export const workstreamsRendererChanges = [
  ['workstreams active by default',
    'MissionsV2:{displayName:"Missions 2.0",statsigName:"missions_v2",defaultValue:!1}',
    'MissionsV2:{displayName:"Missions 2.0",statsigName:"missions_v2",defaultValue:!0}'],
];
