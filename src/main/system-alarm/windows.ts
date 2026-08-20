import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import type { AlarmTarget, SystemAlarmKind, SystemAlarmStatus } from "@shared/types";
import { type SystemAlarmAdapter, statusOf } from "./types";

const execFileAsync = promisify(execFile);

const TASK_NAMES: Record<SystemAlarmKind, string> = {
  "wake-app": "UsagePulse\\Alarm",
  native: "UsagePulse\\AlarmToast"
};

const APP_USER_MODEL_ID = "com.xiaochen26wyl.usagepulse";

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const scriptDir = (): string => join(app.getPath("userData"), "system-alarm");

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// schtasks' /Create flags cannot express WakeToRun, so the task is defined in
// XML instead. Local time with no timezone suffix is what Task Scheduler wants.
const localStamp = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
};

const buildTaskXml = (target: AlarmTarget, command: string, args: string): string => `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Usage-Pulse quota reset alarm</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${localStamp(new Date(target.fireAt))}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Settings>
    <WakeToRun>true</WakeToRun>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(command)}</Command>
      <Arguments>${escapeXml(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;

// A looping toast is the closest Windows equivalent of a real alarm: with
// scenario="alarm" it stays on screen and keeps ringing until dismissed.
// Electron's Notification cannot express that, so raw toast XML via PowerShell
// it is — written to a .ps1 file rather than inlined, to avoid nesting quotes
// inside the task XML.
const buildToastScript = (target: AlarmTarget): string => `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

$template = @"
<toast scenario="alarm">
  <visual>
    <binding template="ToastGeneric">
      <text>Usage-Pulse</text>
      <text>${escapeXml(target.label)}</text>
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.Looping.Alarm" loop="true" />
  <actions>
    <action activationType="system" arguments="dismiss" content="Dismiss" />
  </actions>
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_USER_MODEL_ID}').Show($toast)
`;

const queryTask = async (kind: SystemAlarmKind): Promise<SystemAlarmStatus> => {
  try {
    const { stdout } = await execFileAsync("schtasks", ["/Query", "/TN", TASK_NAMES[kind], "/FO", "LIST", "/V"]);
    const nextRun = /Next Run Time:\s*(.+)/i.exec(stdout)?.[1]?.trim() ?? null;
    if (!nextRun || /^(n\/a|never)$/i.test(nextRun)) {
      return statusOf(kind, "stale", null, "Task exists but has no scheduled run");
    }
    return statusOf(kind, "armed", nextRun);
  } catch (error) {
    const text = errorMessage(error);
    // schtasks exits non-zero both for "no such task" and for real failures, so
    // the message is what separates "not armed" from "something broke".
    if (/cannot find the file specified|does not exist/i.test(text)) {
      return statusOf(kind, "stale", null, "Scheduled task not found");
    }
    return statusOf(kind, "error", null, text);
  }
};

export const windowsAdapter: SystemAlarmAdapter = {
  isSupported: () => true,

  probe(kind: SystemAlarmKind): Promise<SystemAlarmStatus> {
    return queryTask(kind);
  },

  async arm(kind: SystemAlarmKind, target: AlarmTarget): Promise<void> {
    const dir = scriptDir();
    await mkdir(dir, { recursive: true });

    let command: string;
    let args: string;

    if (kind === "wake-app") {
      command = process.execPath;
      args = `--alarm-fired=${target.id}`;
    } else {
      const scriptPath = join(dir, "alarm-toast.ps1");
      await writeFile(scriptPath, buildToastScript(target), "utf-8");
      command = "powershell.exe";
      args = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}"`;
    }

    const xmlPath = join(dir, kind === "wake-app" ? "wake-app.xml" : "native.xml");
    // Task Scheduler reads task XML as UTF-16LE.
    await writeFile(xmlPath, buildTaskXml(target, command, args), "utf16le");
    // /F overwrites the same task name, so re-arming never stacks up duplicates.
    await execFileAsync("schtasks", ["/Create", "/TN", TASK_NAMES[kind], "/XML", xmlPath, "/F"]);
    await rm(xmlPath, { force: true }).catch(() => undefined);
  },

  async clear(kind: SystemAlarmKind): Promise<void> {
    await execFileAsync("schtasks", ["/Delete", "/TN", TASK_NAMES[kind], "/F"]).catch(() => undefined);
  }
};
