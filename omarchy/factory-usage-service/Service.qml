// Factory usage refresh service for the Omarchy shell.
//
// Periodically runs this plugin's own Factory collector so a fresh JSON
// usage record lands in ~/.local/state/omarchy/agents/usage/, where the
// agents panel discovers it at its next refresh. Runs only while the
// plugin is enabled in shell.json; disabling it stops the timer entirely.
//
// The collector runs against the installed vendor bundle
// (/opt/factory-desktop-arch) but the collector/helper code lives inside
// THIS plugin directory, so collector updates deploy without reinstalling
// the package. Paths are resolved from the plugin's own location via
// Qt.resolvedUrl().toLocalFile() (URL-escaped correctly, no shell
// interpolation; the Process command is an argv array).
//
// Force refreshes from the agents panel go through the user's
// omarchy-agent-usage-update wrapper, which can invoke the same collector
// (see README); the collector's own file lock prevents concurrent runs.

import QtQuick
import Quickshell
import Quickshell.Io

Item {
    id: service

    // Injected by the omarchy shell service loader.
    property var shell: null

    readonly property int refreshIntervalSec: 900
    readonly property string bundlePath: Quickshell.env("FACTORY_DESKTOP_BUNDLE") !== ""
        ? Quickshell.env("FACTORY_DESKTOP_BUNDLE") : "/opt/factory-desktop-arch"

    // This plugin's directory as a plain filesystem path. Decoding the file
    // URL handles spaces and other URL-escaped characters (%20 and friends);
    // no shell is involved and the Process command is an argv array.
    readonly property string pluginDir: decodeURIComponent(
      Qt.resolvedUrl(".").toString().replace(/^file:\/\//, "").replace(/\/$/, ""))

    readonly property string localRunner: pluginDir + "/bin/factory-usage"

    Process {
        id: refreshProcess
        running: false
        // argv array only: no shell, no interpolation, spaces are safe.
        command: [service.localRunner, "--write"]
        // The collector is bounded by its own timeouts and lock; nothing is
        // expected on stdout, and nothing is logged to avoid noise.
        stdout: SplitParser {}
        onExited: function (exitCode) {
            if (exitCode !== 0)
                console.warn("factory-usage-service: refresh failed with exit code", exitCode)
        }
    }

    Timer {
        id: refreshTimer
        interval: service.refreshIntervalSec * 1000
        repeat: true
        triggeredOnStart: true
        onTriggered: {
            if (!refreshProcess.running)
                refreshProcess.running = true
        }
    }

    Component.onCompleted: refreshTimer.start()
    Component.onDestruction: refreshTimer.stop()
}
