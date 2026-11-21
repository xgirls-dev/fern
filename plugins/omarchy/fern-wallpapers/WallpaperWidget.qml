import QtQuick
import QtQuick.Controls.Basic as Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons as Commons
import qs.Ui as OmarchyUi

OmarchyUi.Panel {
    id: root

    moduleName: "xgirls-dev.fern-wallpapers"
    manageIpc: false
    implicitWidth: button.implicitWidth
    implicitHeight: button.implicitHeight

    readonly property string helper: decodeURIComponent(Qt.resolvedUrl("wallpaper.py").toString().slice(7))
    readonly property bool busy: generation.running || applying.running
    property string pendingPrompt: ""
    property string previewPath: ""
    property url previewUrl: ""
    property string statusText: ""

    function readResult(output, exitCode) {
        let result
        try {
            result = JSON.parse(output)
        } catch (error) {
            result = null
        }
        if (result && exitCode === 0) return result
        statusText = result?.error || "Fern Wallpapers could not run its Python helper."
        return null
    }

    function generate(prompt) {
        if (busy || !prompt.trim()) return
        pendingPrompt = prompt.trim()
        statusText = "Generating in Fern…"
        generation.running = true
    }

    function applyWallpaper() {
        if (busy || !previewPath) return
        statusText = "Applying wallpaper…"
        applying.command = ["python3", helper, "apply", previewPath]
        applying.running = true
    }

    Process {
        id: generation
        command: ["python3", root.helper, "generate"]
        environment: ({ PYTHONUTF8: "1" })
        stdinEnabled: true
        stdout: StdioCollector { id: generationOutput }
        onStarted: {
            write(root.pendingPrompt + "\n")
            root.pendingPrompt = ""
        }
        onRunningChanged: {
            if (!running && root.pendingPrompt) {
                root.pendingPrompt = ""
                root.statusText = "Could not start Python 3."
            }
        }
        onExited: function(exitCode) {
            const result = root.readResult(generationOutput.text, exitCode)
            if (result) {
                root.previewPath = result.path
                root.previewUrl = result.url
                root.statusText = ""
            }
        }
    }

    Process {
        id: applying
        stdout: StdioCollector { id: applyOutput }
        onRunningChanged: {
            if (!running && root.statusText === "Applying wallpaper…") {
                root.statusText = "Could not start Python 3."
            }
        }
        onExited: function(exitCode) {
            const result = root.readResult(applyOutput.text, exitCode)
            if (result) root.statusText = "Wallpaper applied."
        }
    }

    OmarchyUi.BarIconButton {
        id: button
        anchors.fill: parent
        bar: root.bar
        text: "󰸉"
        tooltipText: "Fern Wallpapers"
        onPressed: function(buttonCode) {
            if (buttonCode === Qt.LeftButton) root.toggle()
        }
    }

    OmarchyUi.KeyboardPanel {
        id: panel
        anchorItem: button
        owner: root
        bar: root.bar
        open: root.opened
        focusTarget: loadedContent ? loadedContent.promptField : null
        contentWidth: fittedContentWidth(Commons.Style.space(400))
        contentHeight: fittedContentHeight(loadedContentHeight, Commons.Style.space(590))

        content: ColumnLayout {
            property alias promptField: prompt

            width: parent.width
            spacing: Commons.Style.space(10)
            Keys.onEscapePressed: root.close()

            Text {
                text: "Fern Wallpapers"
                color: Commons.Color.foreground
                font.pixelSize: Commons.Style.space(19)
                font.bold: true
            }

            Controls.TextField {
                id: prompt
                Layout.fillWidth: true
                Accessible.name: "Wallpaper prompt"
                placeholderText: "Describe the wallpaper you want"
                maximumLength: 2000
                color: Commons.Color.foreground
                placeholderTextColor: Commons.Color.foreground
                selectionColor: Commons.Color.foreground
                selectedTextColor: Commons.Color.background
                leftPadding: Commons.Style.space(10)
                rightPadding: Commons.Style.space(10)
                topPadding: Commons.Style.space(9)
                bottomPadding: Commons.Style.space(9)
                background: Rectangle {
                    radius: Commons.Style.space(5)
                    color: Commons.Color.background
                    border.color: Commons.Color.foreground
                    border.width: prompt.activeFocus ? 2 : 1
                }
                onAccepted: root.generate(text)
            }

            Image {
                id: preview
                Layout.fillWidth: true
                Layout.preferredHeight: visible ? width * 9 / 16 : 0
                visible: root.previewPath !== ""
                source: root.previewUrl
                sourceSize.width: 800
                asynchronous: true
                fillMode: Image.PreserveAspectFit
                Accessible.name: "Generated wallpaper preview"
                onStatusChanged: {
                    if (status === Image.Error) root.statusText = "The generated preview is no longer available."
                }
            }

            Text {
                Layout.fillWidth: true
                visible: text.length > 0
                text: root.statusText
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: Commons.Color.foreground
                font.pixelSize: Commons.Style.space(12)
            }

            RowLayout {
                Layout.fillWidth: true

                Controls.Button {
                    text: "Open Fern"
                    onClicked: {
                        Quickshell.execDetached(["fern"])
                        root.close()
                    }
                }

                Item { Layout.fillWidth: true }

                Controls.Button {
                    text: "Generate"
                    enabled: !root.busy && prompt.text.trim().length > 0
                    onClicked: root.generate(prompt.text)
                }

                Controls.Button {
                    text: "Apply"
                    visible: root.previewPath !== ""
                    enabled: !root.busy && preview.status === Image.Ready
                    onClicked: root.applyWallpaper()
                }
            }
        }
    }
}
