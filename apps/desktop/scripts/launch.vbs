Set shell = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
desktopDir = fso.GetParentFolderName(scriptDir)
rootDir = fso.GetParentFolderName(desktopDir)
startScript = scriptDir & "\start.mjs"

nodeCmd = "node"
On Error Resume Next
shell.Run "where node", 0, True
If Err.Number <> 0 Then
  nodeCmd = "C:\Program Files\nodejs\node.exe"
End If
On Error GoTo 0

cmd = """" & nodeCmd & """ """ & startScript & """"
shell.CurrentDirectory = desktopDir
shell.Run cmd, 0, False