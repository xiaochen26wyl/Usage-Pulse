import { exec } from "node:child_process";
import { promisify } from "node:util";
import { app } from "electron";
import type { AlarmSyncStatus } from "@shared/types";
import type { SystemAlarmManager } from "./system-alarm";

const execAsync = promisify(exec);
const APP_ID = "com.zorawl.usagepulse";

export class WindowsToastAlarm implements SystemAlarmManager {
  constructor() {
    app.setAppUserModelId(APP_ID);
  }

  async upsert(id: string, fireAt: string, title: string, body: string): Promise<void> {
    const date = new Date(fireAt);
    if (isNaN(date.getTime()) || date.getTime() <= Date.now()) {
      return;
    }

    // PowerShell script to schedule toast
    const psScript = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ScheduledToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null

$xmlString = @"
<toast scenario=""alarm"">
    <visual>
        <binding template=""ToastGeneric"">
            <text>$([Security.SecurityElement]::Escape("${title}"))</text>
            <text>$([Security.SecurityElement]::Escape("${body}"))</text>
        </binding>
    </visual>
    <audio src=""ms-winsoundevent:Notification.Looping.Alarm"" loop=""true""/>
    <actions>
        <action content=""Dismiss"" arguments=""dismiss""/>
    </actions>
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlString)

$time = [DateTimeOffset]::Parse("${date.toISOString()}")
$toast = New-Object Windows.UI.Notifications.ScheduledToastNotification ($xml, $time)
$toast.Tag = "${id}"
$toast.Group = "UsagePulse"

$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("${APP_ID}")

# Remove existing
$scheduled = $notifier.GetScheduledToastNotifications()
foreach ($s in $scheduled) {
    if ($s.Tag -eq "${id}") {
        $notifier.RemoveFromSchedule($s)
    }
}

$notifier.AddToSchedule($toast)
`;

    const encodedCmd = Buffer.from(psScript, "utf-16le").toString("base64");

    try {
      await execAsync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encodedCmd}`);
    } catch (e) {
      console.error("[Usage-Pulse] Failed to upsert windows toast alarm:", e);
    }
  }

  async remove(id: string, _title: string): Promise<void> {
    const psScript = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("${APP_ID}")
$scheduled = $notifier.GetScheduledToastNotifications()
foreach ($s in $scheduled) {
    if ($s.Tag -eq "${id}") {
        $notifier.RemoveFromSchedule($s)
    }
}
`;
    const encodedCmd = Buffer.from(psScript, "utf-16le").toString("base64");

    try {
      await execAsync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encodedCmd}`);
    } catch (e) {
      console.error("[Usage-Pulse] Failed to remove windows toast alarm:", e);
    }
  }

  async status(): Promise<AlarmSyncStatus> {
    // Windows PowerShell method doesn't strictly need a "check if installed" 
    // because it uses built-in WinRT from Windows 10+.
    return "synced";
  }
}
